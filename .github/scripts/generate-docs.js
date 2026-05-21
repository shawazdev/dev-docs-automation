/**
 * generate-docs.js
 *
 * Triggered on PR merge or direct push to main.
 * Classifies the change based on file paths, labels, and title/message —
 * tuned for: Shopify themes, Laravel + React, Shopify apps, WordPress.
 *
 * De-duplication:
 *   When a PR is merged via GitHub UI, both pull_request and push events
 *   fire. The push handler queries the GitHub API to see if the commit
 *   came from a merged PR. If yes, it skips (the PR handler logs it).
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
  diffMaxChars:     10000,
  insertAtTop:       true,
  model:           'gpt-4o',
  temperature:        0.3,
  maxTokens:         1024,
};

let CONFIG = { ...DEFAULTS };
const configPath = '.github/ai-docs.config.json';
if (fs.existsSync(configPath)) {
  try {
    CONFIG = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    console.log('Loaded config overrides from', configPath);
  } catch (err) {
    console.warn('Could not parse', configPath, '— using defaults:', err.message);
  }
}

// ─── Event detection & context loading ───────────────────────────────────────

const eventName  = process.env.EVENT_NAME || 'unknown';
const isPushEvent = eventName === 'push';
const repoName   = process.env.REPO_NAME || 'unknown-repo';

let entryId, entryTitle, entryBody, entryUrl, entryAuthor, entryTime, labels, shortSha;

if (isPushEvent) {
  // Push event — limited data, no PR metadata
  const sha = process.env.COMMIT_SHA || '';
  shortSha    = sha.slice(0, 7) || 'unknown';
  entryId     = shortSha;
  entryTitle  = (process.env.COMMIT_MESSAGE || '').split('\n')[0] || '(no commit message)';
  entryBody   = process.env.COMMIT_MESSAGE || '';
  entryUrl    = process.env.COMMIT_URL || '';
  entryAuthor = process.env.COMMIT_AUTHOR || process.env.PUSHER || 'unknown';
  entryTime   = process.env.COMMIT_TIME || new Date().toISOString();
  labels      = [];
} else {
  // PR event — full metadata
  entryId     = process.env.PR_NUMBER || '?';
  entryTitle  = process.env.PR_TITLE || '(no title)';
  entryBody   = process.env.PR_BODY || '';
  entryUrl    = process.env.PR_URL || '';
  entryAuthor = process.env.PR_AUTHOR || 'unknown';
  entryTime   = process.env.PR_MERGED_AT || new Date().toISOString();
  try {
    labels = JSON.parse(process.env.PR_LABELS || '[]').map(l => l.name.toLowerCase());
  } catch (_) { labels = []; }
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

const timestamp = entryTime.replace('T', ' ').slice(0, 16) + ' UTC';
const filesArr  = changedFiles.split('\n').filter(Boolean);

// ─── De-duplication: skip push if it came from a merged PR ───────────────────

async function isCommitFromMergedPR() {
  if (!isPushEvent) return false;
  const sha = process.env.COMMIT_SHA;
  if (!sha) return false;

  try {
    const url = `https://api.github.com/repos/${repoName}/commits/${sha}/pulls`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!response.ok) {
      console.warn(`PR-association check returned ${response.status} — proceeding with push entry`);
      return false;
    }
    const prs = await response.json();
    const mergedPR = Array.isArray(prs) && prs.find(pr => pr.merged_at);
    if (mergedPR) {
      console.log(`Commit ${sha.slice(0, 7)} is associated with merged PR #${mergedPR.number}.`);
      console.log('Skipping push entry — PR workflow will produce the higher-quality entry.');
      return true;
    }
  } catch (err) {
    console.warn('Could not check PR association:', err.message);
  }
  return false;
}

// ─── File-type detection ─────────────────────────────────────────────────────

const isDoc = f =>
  /\.(md|markdown|rst|txt|adoc)$/i.test(f) ||
  /(^|\/)(README|LICENSE|CHANGELOG|CONTRIBUTING)/i.test(f) ||
  /(^|\/)docs?\//i.test(f);

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

const isBackend = f =>
  isLaravelBackend(f) || isShopifyAppBackend(f) || isWordPressPlugin(f);

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

// ─── Title keyword helpers ───────────────────────────────────────────────────

const titleHas = (...words) =>
  words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(entryTitle));

// ─── Rule engine ─────────────────────────────────────────────────────────────

function classify() {
  if (labels.includes('skip-log'))     return { action: 'skip', reason: 'skip-log label' };
  if (labels.includes('log-detailed')) return { action: 'full', reason: 'log-detailed label' };
  if (labels.includes('hotfix'))       return { action: 'full', reason: 'hotfix label', tag: 'HOTFIX' };
  if (/^revert/i.test(entryTitle))     return { action: 'full', reason: 'revert', tag: 'REVERT' };

  if (filesArr.length === 0)
    return { action: 'full', reason: 'no file list — defaulting to full' };

  if (filesArr.every(isDoc))
    return { action: 'oneline', reason: 'documentation-only update' };

  if (filesArr.every(isTranslation))
    return { action: 'oneline', reason: 'translations-only update' };

  if (filesArr.some(isDatabase))
    return { action: 'full', reason: 'database / migration change', tag: 'DB' };

  if (filesArr.some(isConfig) && totalLines > CONFIG.configMinLines)
    return { action: 'full', reason: 'config update', tag: 'CONFIG' };

  if (filesArr.some(isBackend))
    return { action: 'full', reason: 'backend / server logic change', tag: 'BACKEND' };

  if (filesArr.some(isShopifyAPI))
    return { action: 'full', reason: 'Shopify checkout / API change', tag: 'SHOPIFY' };

  if (labels.some(l => ['bug', 'bugfix', 'fix'].includes(l)) ||
      titleHas('fix', 'fixes', 'fixed', 'bug', 'bugfix', 'patch'))
    return { action: 'full', reason: 'bug fix', tag: 'FIX' };

  if (labels.some(l => ['feature', 'feat', 'enhancement'].includes(l)) ||
      titleHas('feat', 'feature', 'add', 'added', 'adds', 'new', 'implement', 'introduce'))
    return { action: 'full', reason: 'new feature', tag: 'FEATURE' };

  if (titleHas('refactor', 'refactored', 'refactoring') || labels.includes('refactor')) {
    return totalLines > CONFIG.smallRefactorLines
      ? { action: 'full',    reason: `large refactor (${totalLines} lines)`, tag: 'REFACTOR' }
      : { action: 'oneline', reason: `small refactor (${totalLines} lines)` };
  }

  if (filesArr.every(isThemeTemplate)) {
    return totalLines > CONFIG.themeTemplateLines
      ? { action: 'full',    reason: `large theme template change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small theme template change (${totalLines} lines)` };
  }

  if (filesArr.every(isReactComponent)) {
    return totalLines > CONFIG.reactComponentLines
      ? { action: 'full',    reason: `large React component change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small React component change (${totalLines} lines)` };
  }

  if (filesArr.every(isStyling)) {
    return totalLines > CONFIG.stylingLines
      ? { action: 'full',    reason: `large CSS/styling change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small CSS/styling change (${totalLines} lines)` };
  }

  return { action: 'full', reason: 'default (no specific rule matched)' };
}

// ─── AI prompt ───────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior technical writer.
Produce clear, concise changelog entries from git diffs for a team that builds
Shopify themes, Laravel + React applications, Shopify apps, and WordPress sites.

Rules:
- Be specific. "Added JWT auth to /login endpoint" not "improved security"
- Lead with impact
- One line per bullet
- Tag each change: [Feature] [Fix] [Refactor] [Breaking] [API Change] [DB] [Config] [Shopify] [WP]
- Plain text only — no markdown, no asterisks, no headers`;

function buildUserPrompt() {
  const sourceLine = isPushEvent
    ? `Direct push commit ${shortSha}: ${entryTitle}`
    : `PR #${entryId}: ${entryTitle}`;

  return `Write a changelog entry for this merged change.

Repository: ${repoName}
Source: ${sourceLine}
Author: ${entryAuthor}
Merged: ${timestamp}
URL: ${entryUrl}
Labels: ${labels.join(', ') || 'none'}
Lines changed: +${additions} / -${deletions}

Description / commit body:
${entryBody || '(none)'}

Changed files (${filesArr.length}):
${changedFiles || '(none)'}

Diff (truncated to ${CONFIG.diffMaxChars} chars):
${codeDiff || '(none)'}

---
Respond in this exact format (plain text):

SUMMARY
One sentence describing the overall change.

CHANGES
• [Tag] Description
• [Tag] Description
(3–7 bullets, skip trivial whitespace/formatting changes)

AFFECTED AREAS
Comma-separated modules or features touched.

KEY SNIPPETS
Up to 3 of the most important code lines, one per line, prefixed with the file path.

NOTES
Migration steps, breaking changes, or caveats. Write "None" if nothing special.`;
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

// ─── Entry formatters ────────────────────────────────────────────────────────

const DIVIDER = '────────────────────────────────────────────────────────────';

function entryHeader(tag) {
  const tagPart = tag ? `[${tag}]  ` : '';
  if (isPushEvent) {
    return `${tagPart}[DIRECT PUSH]  Commit ${shortSha}: ${entryTitle}`;
  }
  return `${tagPart}PR #${entryId}: ${entryTitle}`;
}

function fullEntry(aiContent, tag) {
  return [
    DIVIDER,
    entryHeader(tag),
    `Author: ${entryAuthor}    Merged: ${timestamp}`,
    `Labels: ${labels.join(', ') || 'none'}`,
    `Link: ${entryUrl}`,
    `Files changed (${filesArr.length}): ${filesArr.join(', ') || 'none'}`,
    '',
    aiContent,
    '',
    '',
  ].join('\n');
}

function oneLineEntry(reason) {
  const idLabel = isPushEvent ? `Commit ${shortSha}` : `PR #${entryId}`;
  const source  = isPushEvent ? ' [DIRECT PUSH]' : '';
  return `• [${timestamp}]${source} ${idLabel} — ${entryTitle} — ${entryAuthor} (${reason}) — ${entryUrl}\n\n`;
}

function fallbackEntry(errorMsg) {
  return [
    DIVIDER,
    `[NEEDS REVIEW]  ${entryHeader()}`,
    `Author: ${entryAuthor}    Merged: ${timestamp}`,
    `Labels: ${labels.join(', ') || 'none'}`,
    `Link: ${entryUrl}`,
    `Files changed (${filesArr.length}): ${filesArr.join(', ') || 'none'}`,
    '',
    `AI summary unavailable: ${errorMsg}`,
    'Please open the link above and add a manual summary if needed.',
    '',
    '',
  ].join('\n');
}

// ─── Google Docs writer ──────────────────────────────────────────────────────

async function insertIntoDoc(text) {
  const serviceAccount = JSON.parse(process.env.GDOCS_SERVICE_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/documents'],
  });
  const docs  = google.docs({ version: 'v1', auth });
  const docId = process.env.GDOC_ID;

  let location;
  if (CONFIG.insertAtTop) {
    location = { index: 1 };
  } else {
    const doc      = await docs.documents.get({ documentId: docId });
    const endIndex = doc.data.body.content.slice(-1)[0].endIndex - 1;
    location = { index: endIndex };
  }

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: { requests: [{ insertText: { location, text } }] },
  });

  console.log(`Entry written to https://docs.google.com/document/d/${docId}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`Event: ${eventName}`);
  console.log(`Repo:  ${repoName}`);
  console.log(`Title: ${entryTitle}`);
  console.log(`Author: ${entryAuthor}`);
  console.log(`Lines:  +${additions} / -${deletions}  (total ${totalLines})`);
  console.log(`Files:  ${filesArr.length}`);
  console.log(`Labels: ${labels.join(', ') || 'none'}`);

  // De-dup: push events that came from a merged PR should be skipped
  if (await isCommitFromMergedPR()) return;

  const decision = classify();
  console.log(`Decision: ${decision.action.toUpperCase()} — ${decision.reason}`);

  if (decision.action === 'skip') {
    console.log('Skipping log entry per rules. Done.');
    return;
  }

  let entry;
  if (decision.action === 'oneline') {
    entry = oneLineEntry(decision.reason);
  } else {
    try {
      const aiContent = await generateAISummary();
      entry = fullEntry(aiContent, decision.tag);
    } catch (err) {
      console.error('AI summary failed:', err.message);
      entry = fallbackEntry(err.message);
    }
  }

  try {
    await insertIntoDoc(entry);
  } catch (err) {
    console.error('Failed to write to Google Docs:', err.message);
    fs.writeFileSync('failed-entry.txt', entry);
    console.error('Entry saved to failed-entry.txt — uploaded as workflow artifact.');
    process.exit(1);
  }
})();
