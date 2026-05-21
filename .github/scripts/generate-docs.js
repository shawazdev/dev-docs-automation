/**
 * generate-docs.js
 *
 * Triggered on PR merge or direct push to main. Writes rich-formatted
 * changelog entries to a Google Doc with:
 *   - Date pill header (background-coloured, bold)
 *   - One-line title + author
 *   - Per-functionality breakdown (file path + process steps)
 *   - Decorative divider between entries
 *
 * Tuned for: Shopify themes, Laravel + React, Shopify apps, WordPress.
 *
 * Required GitHub Secrets:
 *   GDOCS_SERVICE_JSON  – Google service-account JSON (full string)
 *   GDOC_ID             – ID of this repo's target Google Doc
 *   GITHUB_TOKEN        – auto-provided when 'models: read' permission is set
 *
 * Optional per-repo override:
 *   .github/ai-docs.config.json
 */

const fs = require('fs');
const ModelClient = require('@azure-rest/ai-inference').default;
const { AzureKeyCredential } = require('@azure/core-auth');
const { google } = require('googleapis');

// ─── Configuration ───────────────────────────────────────────────────────────

const DEFAULTS = {
  smallRefactorLines:  50,
  themeTemplateLines:  40,
  reactComponentLines: 50,
  stylingLines:        30,
  configMinLines:       5,
  diffMaxChars:     80000,    // big enough for large multi-file pushes
  largePushFileCount:  20,    // pushes touching ≥ this many files get extra prompt nudges
  insertAtTop:       true,
  model:           'gpt-4o',
  temperature:        0.3,
  maxTokens:         3000,
};

let CONFIG = { ...DEFAULTS };
const configPath = '.github/ai-docs.config.json';
if (fs.existsSync(configPath)) {
  try {
    CONFIG = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch (err) {
    console.warn('Could not parse', configPath, '— using defaults:', err.message);
  }
}

// ─── Event detection & context loading ───────────────────────────────────────

const eventName  = process.env.EVENT_NAME || 'unknown';
const isPushEvent = eventName === 'push';
const repoName   = process.env.REPO_NAME || 'unknown-repo';

let entryId, entryTitle, entryBody, entryUrl, entryAuthor, entryTime, labels, shortSha;
// FIX 1: Track the branch that was merged in (for push events that include a merge)
let mergedFromBranch = '';

// Recognised inline tags developers can include in commit messages or PR
// titles/descriptions. Useful for direct pushes (which have no PR labels)
// or as a backup when someone forgets to apply a label on a PR.
//
// Format: just write [tag-name] anywhere in the commit message or PR body.
//   git commit -m "fix: emergency cart bug [hotfix]"
//   git commit -m "wip: experiments [skip-log]"
//   git commit -m "feat: full cart drawer rewrite [log-detailed]"
const KNOWN_TAGS = [
  'skip-log', 'log-detailed', 'hotfix',
  'bug', 'bugfix', 'fix',
  'feature', 'feat', 'enhancement',
  'refactor',
];

function extractTagsFromText(text) {
  if (!text) return [];
  const pattern = new RegExp(`\\[(${KNOWN_TAGS.join('|')})\\]`, 'gi');
  const matches = [...text.matchAll(pattern)];
  return [...new Set(matches.map(m => m[1].toLowerCase()))];
}

// FIX 1: Extract merged branch name from commit messages like:
//   "Merge branch 'feature/my-feature' into main"
//   "Merge pull request #12 from org/feature/my-feature"
//   "Merged feature/my-feature"
function extractMergedBranch(commitMessage) {
  if (!commitMessage) return '';
  const patterns = [
    /^Merge branch '([^']+)'/im,
    /^Merge pull request #\d+ from [^/]+\/(.+)/im,
    /^Merged? (\S+) into/im,
  ];
  for (const re of patterns) {
    const m = commitMessage.match(re);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

if (isPushEvent) {
  const sha = process.env.COMMIT_SHA || '';
  shortSha    = sha.slice(0, 7) || 'unknown';
  entryId     = shortSha;
  entryTitle  = (process.env.COMMIT_MESSAGE || '').split('\n')[0] || '(no commit message)';
  entryBody   = process.env.COMMIT_MESSAGE || '';
  entryUrl    = process.env.COMMIT_URL || '';
  entryAuthor = process.env.COMMIT_AUTHOR || process.env.PUSHER || 'unknown';
  entryTime   = process.env.COMMIT_TIME || new Date().toISOString();
  // No GitHub labels on a raw push — extract tags from commit message instead
  labels = extractTagsFromText(entryBody);
  // FIX 1: Detect if this push was a merge from another branch
  mergedFromBranch = extractMergedBranch(entryBody);
} else {
  entryId     = process.env.PR_NUMBER || '?';
  entryTitle  = process.env.PR_TITLE || '(no title)';
  entryBody   = process.env.PR_BODY || '';
  entryUrl    = process.env.PR_URL || '';
  entryAuthor = process.env.PR_AUTHOR || 'unknown';
  entryTime   = process.env.PR_MERGED_AT || new Date().toISOString();
  try {
    labels = JSON.parse(process.env.PR_LABELS || '[]').map(l => l.name.toLowerCase());
  } catch (_) { labels = []; }
  // Backup: also pick up tags written in the PR title/body, in case a label
  // wasn't applied. Union with any real labels already set.
  for (const t of extractTagsFromText(`${entryTitle} ${entryBody}`)) {
    if (!labels.includes(t)) labels.push(t);
  }
}

const additions  = parseInt(process.env.DIFF_ADDITIONS || '0', 10);
const deletions  = parseInt(process.env.DIFF_DELETIONS || '0', 10);
const totalLines = additions + deletions;

const changedFiles = fs.existsSync('changed_files.txt')
  ? fs.readFileSync('changed_files.txt', 'utf8').trim()
  : '';
const codeDiff = fs.existsSync('code_diff.txt')
  ? fs.readFileSync('code_diff.txt', 'utf8').slice(0, CONFIG.diffMaxChars)
  : '';

const dateObj  = new Date(entryTime);
const datePill = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const timeStr  = entryTime.replace('T', ' ').slice(0, 16) + ' UTC';
const filesArr = changedFiles.split('\n').filter(Boolean);

// ─── De-duplication ──────────────────────────────────────────────────────────

async function isCommitFromMergedPR() {
  if (!isPushEvent) return false;
  const sha = process.env.COMMIT_SHA;
  if (!sha) return false;
  try {
    const r = await fetch(`https://api.github.com/repos/${repoName}/commits/${sha}/pulls`, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!r.ok) return false;
    const prs = await r.json();
    const merged = Array.isArray(prs) && prs.find(p => p.merged_at);
    if (merged) {
      console.log(`Commit ${sha.slice(0, 7)} is from merged PR #${merged.number}. Skipping push entry.`);
      return true;
    }
  } catch (err) {
    console.warn('PR-association check failed:', err.message);
  }
  return false;
}

// ─── File-type detection ─────────────────────────────────────────────────────

const isDoc = f =>
  /\.(md|markdown|rst|txt|adoc)$/i.test(f) ||
  /(^|\/)(README|LICENSE|CHANGELOG|CONTRIBUTING)/i.test(f) ||
  /(^|\/)docs?\//i.test(f);

const isGithubMeta = f =>
  /^\.github\//i.test(f);

const isTranslation = f =>
  /(^|\/)(locales?|lang|i18n|translations?)\//i.test(f) ||
  /\.(po|mo|pot)$/i.test(f);

const isDatabase = f =>
  /\.sql$/i.test(f) ||
  /(^|\/)database\/(migrations?|seeders?|seeds?|factories?)\//i.test(f) ||
  /(^|\/)(migrations?|seeds?)\//i.test(f) ||
  /(^|\/)prisma\/(schema\.prisma|migrations\/)/i.test(f);

const isConfig = f =>
  /^\.env/i.test(f) ||
  /(^|\/)wp-config\.php$/i.test(f) ||
  /(^|\/)shopify\.(app|web|extension)\.toml$/i.test(f) ||
  /(^|\/)composer\.(json|lock)$/i.test(f) ||
  /(^|\/)package(-lock)?\.json$/i.test(f) ||
  /(^|\/)config\//i.test(f) ||
  /(^|\/)Dockerfile$/i.test(f) ||
  /\.config\.(js|ts|json|mjs|cjs)$/i.test(f) ||
  /\.(yml|yaml|toml|ini|conf)$/i.test(f);

// FIX 2: Detect .yml/.yaml workflow/CI files and standalone .js config/tooling files
// that should never appear as functionality blocks in the documentation.
const isWorkflowOrToolingFile = f =>
  /\.(yml|yaml)$/i.test(f) ||                          // all YAML files (CI, workflows, configs)
  /^\.github\//i.test(f) ||                            // anything under .github/
  /\.(config|setup|build)\.(js|mjs|cjs)$/i.test(f) || // e.g. vite.config.js, webpack.config.js
  /(^|\/)\.eslintrc(\.(js|json|yml))?$/i.test(f) ||   // ESLint config
  /(^|\/)\.prettierrc(\.(js|json|yml))?$/i.test(f) || // Prettier config
  /(^|\/)jest\.config\.(js|ts)$/i.test(f) ||          // Jest config
  /(^|\/)babel\.config\.(js|json)$/i.test(f);          // Babel config

const isLaravelBackend = f =>
  /(^|\/)app\/Http\/Controllers\//i.test(f) ||
  /(^|\/)app\/Models?\//i.test(f) ||
  /(^|\/)app\/Services\//i.test(f) ||
  /(^|\/)app\/Repositories\//i.test(f) ||
  /(^|\/)app\/Jobs\//i.test(f) ||
  /(^|\/)routes\/.+\.php$/i.test(f);

const isShopifyAppBackend = f =>
  /(^|\/)app\/routes\//i.test(f) ||
  /(^|\/)app\/models?\//i.test(f) ||
  /(^|\/)webhooks\//i.test(f);

const isWordPressPlugin = f =>
  /(^|\/)wp-content\/plugins\//i.test(f) ||
  /(^|\/)functions\.php$/i.test(f);

const isBackend = f => isLaravelBackend(f) || isShopifyAppBackend(f) || isWordPressPlugin(f);

const isShopifyAPI = f =>
  /(^|\/)extensions\//i.test(f) ||
  /shopify-api|admin-api|storefront-api/i.test(f) ||
  /(^|\/)app\/.*\.(graphql|gql)$/i.test(f);

const isLiquidTemplate = f => /\.liquid$/i.test(f);
const isWordPressTheme = f =>
  /(^|\/)wp-content\/themes\/.+\.php$/i.test(f) &&
  !/(^|\/)functions\.php$/i.test(f);
const isThemeTemplate = f => isLiquidTemplate(f) || isWordPressTheme(f);

const isReactComponent = f =>
  /\.(jsx|tsx)$/i.test(f) &&
  (/(^|\/)resources\/js\//i.test(f) || /(^|\/)src\//i.test(f) || /(^|\/)components?\//i.test(f));

const isStyling = f => /\.(css|scss|sass|less|styl)$/i.test(f);

const titleHas = (...words) =>
  words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(entryTitle));

// ─── Rule engine ─────────────────────────────────────────────────────────────

// Detect "merge from upstream" pushes (e.g. pulling main into feature, then
// pushing the merge back). These have generic messages and huge file counts
// but don't represent new work — the original PRs already documented the work.
function isUpstreamMergeCommit() {
  if (!isPushEvent) return false;
  const msg = (process.env.COMMIT_MESSAGE || '').toLowerCase();
  const looksLikeMergeMsg =
    /^merge (branch|remote-tracking branch|pull request)/i.test(msg) ||
    /^pull(ed|ing)? (from|updates from|changes from)/i.test(msg) ||
    /^sync (with|from) (upstream|main|master)/i.test(msg);
  return looksLikeMergeMsg && filesArr.length >= CONFIG.largePushFileCount;
}

// FIX 2: Compute the "meaningful" file list by stripping workflow/tooling files.
// This filtered list is used for classification and AI prompting so that
// .yml/.js tooling files mixed into a real feature push don't pollute the doc.
const meaningfulFilesArr = filesArr.filter(f => !isWorkflowOrToolingFile(f));
const workflowFilesArr   = filesArr.filter(f => isWorkflowOrToolingFile(f));

function classify() {
  // FIX 2: Use meaningfulFilesArr for classification so that a push that
  // touches both feature files and .yml/.js tooling is classified on the
  // feature files alone.
  const mf = meaningfulFilesArr;

  if (labels.includes('skip-log'))     return { action: 'skip', reason: 'skip-log label' };
  if (labels.includes('log-detailed')) return { action: 'full', reason: 'log-detailed label' };
  if (labels.includes('hotfix'))       return { action: 'full', reason: 'hotfix label', tag: 'HOTFIX' };
  if (/^revert/i.test(entryTitle))     return { action: 'full', reason: 'revert', tag: 'REVERT' };

  // .github-only changes (workflow tweaks, this script, config) — never logged.
  if (filesArr.length > 0 && filesArr.every(isGithubMeta))
    return { action: 'skip', reason: '.github-only change (workflow / scripts / metadata)' };

  // If ALL meaningful files are gone after stripping tooling, it's a tooling-only push.
  if (filesArr.length > 0 && mf.length === 0)
    return { action: 'skip', reason: 'tooling/workflow-only change (.yml/.js config files)' };

  // Upstream merges → one-liner.
  if (isUpstreamMergeCommit())
    return { action: 'oneline', reason: `merge from upstream (${filesArr.length} files)` };

  if (mf.length === 0)             return { action: 'full', reason: 'no file list' };
  if (mf.every(isDoc))             return { action: 'oneline', reason: 'documentation-only update' };
  if (mf.every(isTranslation))     return { action: 'oneline', reason: 'translations-only update' };
  if (mf.some(isDatabase))         return { action: 'full', reason: 'database / migration change', tag: 'DB' };
  if (mf.some(isBackend))          return { action: 'full', reason: 'backend / server logic change', tag: 'BACKEND' };
  if (mf.some(isShopifyAPI))       return { action: 'full', reason: 'Shopify checkout / API change', tag: 'SHOPIFY' };

  if (mf.filter(isConfig).length >= Math.ceil(mf.length / 2) &&
      totalLines > CONFIG.configMinLines)
    return { action: 'full', reason: 'config update', tag: 'CONFIG' };

  if (labels.some(l => ['bug','bugfix','fix'].includes(l)) ||
      titleHas('fix','fixes','fixed','bug','bugfix','patch'))
    return { action: 'full', reason: 'bug fix', tag: 'FIX' };
  if (labels.some(l => ['feature','feat','enhancement'].includes(l)) ||
      titleHas('feat','feature','add','added','adds','new','implement','introduce'))
    return { action: 'full', reason: 'new feature', tag: 'FEATURE' };
  if (titleHas('refactor','refactored','refactoring') || labels.includes('refactor')) {
    return totalLines > CONFIG.smallRefactorLines
      ? { action: 'full', reason: `large refactor (${totalLines} lines)`, tag: 'REFACTOR' }
      : { action: 'oneline', reason: `small refactor (${totalLines} lines)` };
  }
  if (mf.every(isThemeTemplate)) {
    return totalLines > CONFIG.themeTemplateLines
      ? { action: 'full', reason: `large theme template change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small theme template change (${totalLines} lines)` };
  }
  if (mf.every(isReactComponent)) {
    return totalLines > CONFIG.reactComponentLines
      ? { action: 'full', reason: `large React component change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small React component change (${totalLines} lines)` };
  }
  if (mf.every(isStyling)) {
    return totalLines > CONFIG.stylingLines
      ? { action: 'full', reason: `large CSS/styling change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small CSS/styling change (${totalLines} lines)` };
  }
  return { action: 'full', reason: 'default (no specific rule matched)' };
}

// ─── AI prompt (new structured format) ───────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior technical writer producing developer changelog entries.
The team builds Shopify themes, Laravel + React apps, Shopify apps, and WordPress sites.

Your job is to read the diff carefully and produce a SPECIFIC entry. Vague summaries
like "updated styles" or "improved theme" are unacceptable. Name the actual features,
components, sliders, modals, sections, endpoints, or behaviours that changed.

Write clearly and specifically. "Added JWT auth to /login endpoint" — not "improved security".
"Added collection slider with autoplay and snap behaviour" — not "updated templates".
Plain text only. No markdown, no asterisks, no headers other than the ones requested.`;

function buildUserPrompt() {
  const source = isPushEvent
    ? `Direct push commit ${shortSha}: ${entryTitle}`
    : `PR #${entryId}: ${entryTitle}`;

  // FIX 2: Pass only the meaningful (non-tooling) file list to the AI so it
  // never generates functionality blocks for .yml/.js workflow files.
  const meaningfulFileList = meaningfulFilesArr.join('\n') || '(none)';
  const isLargeChange = meaningfulFilesArr.length >= CONFIG.largePushFileCount;

  // FIX 2: If workflow/tooling files were present but excluded, tell the AI
  // so it can mention them briefly in NOTES without creating blocks for them.
  const excludedNote = workflowFilesArr.length > 0
    ? `\nExcluded from analysis (workflow/tooling files — do NOT create blocks for these):\n${workflowFilesArr.join('\n')}`
    : '';

  return `Write a structured changelog entry for the following change.

Repository: ${repoName}
Source: ${source}
Author: ${entryAuthor}
Merged: ${timeStr}
URL: ${entryUrl}
Labels: ${labels.join(', ') || 'none'}
Lines changed: +${additions} / -${deletions}
File count: ${meaningfulFilesArr.length} meaningful file(s) (${filesArr.length} total)
${mergedFromBranch ? `Merged from branch: ${mergedFromBranch}` : ''}

Original commit message / PR description (may be generic — see TITLE rules below):
${entryBody || '(none)'}

Changed files — meaningful only (${meaningfulFilesArr.length}):
${meaningfulFileList}${excludedNote}

Diff (up to ${CONFIG.diffMaxChars} characters — scan the WHOLE diff, not just the start):
${codeDiff || '(none)'}

---
Respond in this EXACT plain-text format. Use the section names exactly as written.

TITLE
A short, SPECIFIC title (5–15 words) describing what actually changed.

CRITICAL: If the commit message or PR title is generic — for example
"Merge branch X", "Pulled updates from main", "Sync from upstream",
"WIP", "updates", "changes" — IGNORE it completely and derive the
title from the diff. Name the actual features that were added, fixed,
or changed.

  Bad title:  "Pulled updates from main branch"
  Good title: "Add collection slider, restyle product cards, sync translations"

OVERVIEW
Two or three sentences describing the most important things this change
introduces or modifies. Be concrete. Mention specific features by name.
${mergedFromBranch ? `Also note that these changes were merged from the '${mergedFromBranch}' branch.` : ''}

FUNCTIONALITIES
List each DISTINCT feature or change as a SEPARATE functionality block.

RULES:
- Do NOT group unrelated changes into one block just because they share a
  file type or folder. "Updated Liquid templates" is NOT acceptable.
- Each block must describe ONE coherent feature, component, or behaviour
  (e.g. "Collection slider", "Product variant URL handling", "Cart drawer
  open/close logic", "Stripe checkout webhook").
- If a feature spans multiple files, list all relevant files in File Path
  separated by commas.
- If one file contains multiple features, split into multiple blocks.
- Scan the ENTIRE diff for distinct features. Don't stop after the first
  few changes.
- Only use files from the "Changed files — meaningful only" list above.
  Do NOT reference any files from the "Excluded" list.

DO NOT create functionality blocks for these noise categories — skip them entirely:
- Translation / locale file updates (files in locales/, lang/, i18n/, or .po/.mo files).
- Font additions, font-family declarations, or @font-face rule changes on their own.
- Whitespace, indentation, line-ending, or formatting-only changes.
- Auto-generated files (lock files, build output, minified bundles).
- Comment-only edits.
- Minor dependency version bumps in package.json / composer.json with no real code change.
- Lint / Prettier / editorconfig / .gitignore tweaks.
- Generated migration timestamps with no schema change.
- ANY .yml, .yaml, workflow, or JS config/tooling files (these are already excluded above).

If the diff contains BOTH meaningful features AND noise from the list above,
include only the meaningful features. You may briefly mention the noise in NOTES
(e.g "Also includes translation updates and a font addition.") but do not give
them their own blocks.

${isLargeChange ? `- This is a LARGE change (${meaningfulFilesArr.length} files). Aim for 8–15 functionality
  blocks covering the most significant features. Skip noise per the list above.` : `- Aim for 3–8 functionality blocks. One block per logical feature.`}

Format for each block:

Functionality: [Specific feature or component name — be concrete]
File Path: [exact/path/to/file, or comma-separated paths if one feature spans files]
Process:
- [What specifically changed about this feature]
- [Implementation detail or behaviour change]
- [Impact or how it differs from before]

NOTES
Migration steps, breaking changes, dependencies added/removed, or caveats.
You may also mention skipped noise here (e.g. "Also includes translation updates").
${workflowFilesArr.length > 0 ? `Note: ${workflowFilesArr.length} workflow/tooling file(s) (.yml/.js) were also modified but are not documented here.` : ''}
Write "None" if nothing special.`;
}

// ─── AI call ─────────────────────────────────────────────────────────────────

async function generateAISummary() {
  const client = new ModelClient(
    'https://models.inference.ai.azure.com',
    new AzureKeyCredential(process.env.GITHUB_TOKEN)
  );
  const response = await client.path('/chat/completions').post({
    body: {
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      temperature: CONFIG.temperature,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: buildUserPrompt() },
      ],
    },
  });
  if (response.status !== '200') {
    throw new Error(`GitHub Models error ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body.choices[0].message.content;
}

// ─── AI response parser ──────────────────────────────────────────────────────

function parseAIResponse(text) {
  const out = { title: entryTitle, overview: '', functionalities: [], notes: '' };

  const grab = (name) => {
    const re = new RegExp(`${name}\\s*\\n([\\s\\S]*?)(?=\\n(?:TITLE|OVERVIEW|FUNCTIONALITIES|NOTES)\\s*\\n|$)`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };

  const title = grab('TITLE');
  if (title) out.title = title.split('\n')[0].trim();

  out.overview = grab('OVERVIEW');
  out.notes    = grab('NOTES');

  const funcText = grab('FUNCTIONALITIES');
  if (funcText) {
    const blocks = funcText.split(/(?=^Functionality:)/m).map(b => b.trim()).filter(Boolean);
    for (const block of blocks) {
      const nameMatch = block.match(/Functionality:\s*(.+)/);
      const pathMatch = block.match(/File Path:\s*(.+)/);
      const procMatch = block.match(/Process:\s*\n([\s\S]*)/);
      if (!nameMatch) continue;
      const steps = procMatch
        ? procMatch[1].split('\n').map(l => l.replace(/^\s*[-•*]\s*/, '').trim()).filter(Boolean)
        : [];
      out.functionalities.push({
        name: nameMatch[1].trim(),
        filePath: pathMatch ? pathMatch[1].trim() : '',
        process: steps,
      });
    }
  }
  return out;
}

// ─── Rich-formatted entry builder ────────────────────────────────────────────
//
// Strategy: build a list of {text, style} segments. Insert the full text at
// index 1 in a single API call, then apply text-style updates for each
// segment using tracked character ranges.

const STYLE = {
  datePill: {
    bold: true,
    backgroundColor: { color: { rgbColor: { red: 0.91, green: 0.94, blue: 0.99 } } },
    foregroundColor: { color: { rgbColor: { red: 0.10, green: 0.20, blue: 0.40 } } },
    fontSize: { magnitude: 10, unit: 'PT' },
  },
  titleBold: {
    bold: true,
    fontSize: { magnitude: 12, unit: 'PT' },
  },
  authorMuted: {
    italic: true,
    foregroundColor: { color: { rgbColor: { red: 0.40, green: 0.40, blue: 0.40 } } },
  },
  tagBadge: {
    bold: true,
    backgroundColor: { color: { rgbColor: { red: 1.0, green: 0.93, blue: 0.81 } } },
    foregroundColor: { color: { rgbColor: { red: 0.55, green: 0.25, blue: 0.0 } } },
    fontSize: { magnitude: 9, unit: 'PT' },
  },
  pushBadge: {
    bold: true,
    backgroundColor: { color: { rgbColor: { red: 1.0, green: 0.85, blue: 0.85 } } },
    foregroundColor: { color: { rgbColor: { red: 0.6, green: 0.0, blue: 0.0 } } },
    fontSize: { magnitude: 9, unit: 'PT' },
  },
  // FIX 1: New badge style for the merged-from-branch indicator
  branchBadge: {
    bold: true,
    backgroundColor: { color: { rgbColor: { red: 0.88, green: 0.97, blue: 0.88 } } },
    foregroundColor: { color: { rgbColor: { red: 0.05, green: 0.40, blue: 0.05 } } },
    fontSize: { magnitude: 9, unit: 'PT' },
  },
  sectionLabel: {
    bold: true,
    fontSize: { magnitude: 11, unit: 'PT' },
  },
  filePath: {
    weightedFontFamily: { fontFamily: 'Roboto Mono', weight: 400 },
    foregroundColor: { color: { rgbColor: { red: 0.10, green: 0.50, blue: 0.20 } } },
    fontSize: { magnitude: 10, unit: 'PT' },
  },
  overviewItalic: {
    italic: true,
    foregroundColor: { color: { rgbColor: { red: 0.30, green: 0.30, blue: 0.30 } } },
  },
  dividerGrey: {
    foregroundColor: { color: { rgbColor: { red: 0.75, green: 0.75, blue: 0.75 } } },
  },
  body: {},
};

const FIELDS = {
  datePill:        'bold,backgroundColor,foregroundColor,fontSize',
  titleBold:       'bold,fontSize',
  authorMuted:     'italic,foregroundColor',
  tagBadge:        'bold,backgroundColor,foregroundColor,fontSize',
  pushBadge:       'bold,backgroundColor,foregroundColor,fontSize',
  branchBadge:     'bold,backgroundColor,foregroundColor,fontSize',   // FIX 1
  sectionLabel:    'bold,fontSize',
  filePath:        'weightedFontFamily,foregroundColor,fontSize',
  overviewItalic:  'italic,foregroundColor',
  dividerGrey:     'foregroundColor',
};

function styleRequest(start, end, styleName) {
  if (!STYLE[styleName] || !FIELDS[styleName]) return null;
  return {
    updateTextStyle: {
      range: { startIndex: start, endIndex: end },
      textStyle: STYLE[styleName],
      fields: FIELDS[styleName],
    },
  };
}

function resetStyleRequest(start, end) {
  // Wipe styling on plain body text so it doesn't inherit from previous entries
  return {
    updateTextStyle: {
      range: { startIndex: start, endIndex: end },
      textStyle: {
        bold: false, italic: false,
        backgroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
        foregroundColor: { color: { rgbColor: { red: 0, green: 0, blue: 0 } } },
        fontSize: { magnitude: 11, unit: 'PT' },
        weightedFontFamily: { fontFamily: 'Arial', weight: 400 },
      },
      fields: 'bold,italic,backgroundColor,foregroundColor,fontSize,weightedFontFamily',
    },
  };
}

function buildFullEntrySegments(parsed, tag) {
  const segs = [];

  // Header line: [date]  •  title  •  by author
  segs.push({ text: ` ${datePill} `, style: 'datePill' });
  segs.push({ text: '  ' });

  if (tag) {
    segs.push({ text: ` ${tag} `, style: 'tagBadge' });
    segs.push({ text: '  ' });
  }
  if (isPushEvent) {
    segs.push({ text: ' DIRECT PUSH ', style: 'pushBadge' });
    segs.push({ text: '  ' });
  }
  // FIX 1: Show merged-from-branch badge when applicable
  if (mergedFromBranch) {
    segs.push({ text: ` ← ${mergedFromBranch} `, style: 'branchBadge' });
    segs.push({ text: '  ' });
  }

  segs.push({ text: parsed.title || entryTitle, style: 'titleBold' });
  segs.push({ text: '   ' });
  segs.push({ text: `— by ${entryAuthor}`, style: 'authorMuted' });
  segs.push({ text: '\n' });

  // Meta row
  const meta = `${isPushEvent ? `Commit ${shortSha}` : `PR #${entryId}`}  •  ${timeStr}  •  +${additions} / -${deletions} lines  •  ${filesArr.length} file(s)`;
  segs.push({ text: meta, style: 'authorMuted' });
  segs.push({ text: '\n' });
  if (entryUrl) {
    segs.push({ text: `Link: ${entryUrl}`, style: 'authorMuted' });
    segs.push({ text: '\n' });
  }
  segs.push({ text: '\n' });

  // Overview
  if (parsed.overview) {
    segs.push({ text: parsed.overview, style: 'overviewItalic' });
    segs.push({ text: '\n\n' });
  }

  // Functionalities
  for (const f of parsed.functionalities) {
    segs.push({ text: `Functionality: `, style: 'sectionLabel' });
    segs.push({ text: f.name, style: 'sectionLabel' });
    segs.push({ text: '\n' });

    if (f.filePath) {
      segs.push({ text: `File Path: `, style: 'sectionLabel' });
      segs.push({ text: f.filePath, style: 'filePath' });
      segs.push({ text: '\n' });
    }
    if (f.process.length) {
      segs.push({ text: `Process:`, style: 'sectionLabel' });
      segs.push({ text: '\n' });
      for (const step of f.process) {
        segs.push({ text: `   •  ${step}\n` });
      }
    }
    segs.push({ text: '\n' });
  }

  // Notes
  if (parsed.notes && parsed.notes.toLowerCase() !== 'none') {
    segs.push({ text: `Notes: `, style: 'sectionLabel' });
    segs.push({ text: parsed.notes });
    segs.push({ text: '\n\n' });
  }

  // Divider
  segs.push({ text: '────────────────────  ✦  ────────────────────', style: 'dividerGrey' });
  segs.push({ text: '\n\n' });

  return segs;
}

function buildOneLineSegments(reason) {
  const segs = [];
  segs.push({ text: ` ${datePill} `, style: 'datePill' });
  segs.push({ text: '  ' });
  if (isPushEvent) {
    segs.push({ text: ' DIRECT PUSH ', style: 'pushBadge' });
    segs.push({ text: '  ' });
  }
  // FIX 1: Also show branch badge on one-liner entries
  if (mergedFromBranch) {
    segs.push({ text: ` ← ${mergedFromBranch} `, style: 'branchBadge' });
    segs.push({ text: '  ' });
  }
  segs.push({ text: entryTitle, style: 'titleBold' });
  segs.push({ text: '   ' });
  segs.push({ text: `— by ${entryAuthor}  (${reason})`, style: 'authorMuted' });
  if (entryUrl) {
    segs.push({ text: '   ' });
    segs.push({ text: entryUrl, style: 'authorMuted' });
  }
  segs.push({ text: '\n' });
  segs.push({ text: '────────────────────  ✦  ────────────────────', style: 'dividerGrey' });
  segs.push({ text: '\n\n' });
  return segs;
}

function buildFallbackSegments(errMsg) {
  const segs = [];
  segs.push({ text: ` ${datePill} `, style: 'datePill' });
  segs.push({ text: '  ' });
  segs.push({ text: ' NEEDS REVIEW ', style: 'pushBadge' });
  segs.push({ text: '  ' });
  // FIX 1: Branch badge on fallback entries too
  if (mergedFromBranch) {
    segs.push({ text: ` ← ${mergedFromBranch} `, style: 'branchBadge' });
    segs.push({ text: '  ' });
  }
  segs.push({ text: entryTitle, style: 'titleBold' });
  segs.push({ text: '   ' });
  segs.push({ text: `— by ${entryAuthor}`, style: 'authorMuted' });
  segs.push({ text: '\n\n' });
  segs.push({ text: `AI summary unavailable: ${errMsg}\n`, style: 'overviewItalic' });
  segs.push({ text: `Link: ${entryUrl}\n`, style: 'authorMuted' });
  segs.push({ text: `Files: ${meaningfulFilesArr.join(', ') || 'none'}\n\n` });
  segs.push({ text: '────────────────────  ✦  ────────────────────', style: 'dividerGrey' });
  segs.push({ text: '\n\n' });
  return segs;
}

// ─── Google Docs writer ──────────────────────────────────────────────────────

async function insertRichEntry(segments) {
  const serviceAccount = JSON.parse(process.env.GDOCS_SERVICE_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });
  const docs  = google.docs({ version: 'v1', auth });
  const docId = process.env.GDOC_ID;

  // Decide insertion index
  let insertIndex = 1;
  if (!CONFIG.insertAtTop) {
    const doc = await docs.documents.get({ documentId: docId });
    insertIndex = doc.data.body.content.slice(-1)[0].endIndex - 1;
  }

  // Build full text and per-segment ranges
  let fullText = '';
  const ranges = [];
  for (const seg of segments) {
    const start = insertIndex + fullText.length;
    fullText += seg.text;
    const end = insertIndex + fullText.length;
    ranges.push({ start, end, style: seg.style });
  }

  // Step 1: insert the raw text
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [{ insertText: { location: { index: insertIndex }, text: fullText } }],
    },
  });

  // Step 2: reset styling across the whole entry, then apply per-segment styles
  const formatRequests = [resetStyleRequest(insertIndex, insertIndex + fullText.length)];
  for (const r of ranges) {
    if (r.style && r.end > r.start) {
      const req = styleRequest(r.start, r.end, r.style);
      if (req) formatRequests.push(req);
    }
  }

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: formatRequests },
  });

  console.log(`Entry written to https://docs.google.com/document/d/${docId}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`Event: ${eventName}`);
  console.log(`Repo:  ${repoName}`);
  console.log(`Title: ${entryTitle}`);
  console.log(`Lines: +${additions} / -${deletions}  (total ${totalLines})`);
  console.log(`Files: ${filesArr.length} total, ${meaningfulFilesArr.length} meaningful    Labels: ${labels.join(', ') || 'none'}`);
  if (mergedFromBranch) console.log(`Merged from branch: ${mergedFromBranch}`);
  if (workflowFilesArr.length) console.log(`Excluded tooling files: ${workflowFilesArr.join(', ')}`);

  if (await isCommitFromMergedPR()) return;

  const decision = classify();
  console.log(`Decision: ${decision.action.toUpperCase()} — ${decision.reason}`);

  if (decision.action === 'skip') {
    console.log('Skipping per rules. Done.');
    return;
  }

  let segments;
  if (decision.action === 'oneline') {
    segments = buildOneLineSegments(decision.reason);
  } else {
    try {
      const aiText = await generateAISummary();
      const parsed = parseAIResponse(aiText);
      segments = buildFullEntrySegments(parsed, decision.tag);
    } catch (err) {
      console.error('AI summary failed:', err.message);
      segments = buildFallbackSegments(err.message);
    }
  }

  try {
    await insertRichEntry(segments);
  } catch (err) {
    console.error('Failed to write to Google Docs:', err.message);
    // Plain-text fallback file so the run still preserves data
    const plain = segments.map(s => s.text).join('');
    fs.writeFileSync('failed-entry.txt', plain);
    process.exit(1);
  }
})();