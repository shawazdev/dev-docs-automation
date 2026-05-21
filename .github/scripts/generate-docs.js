/**
 * generate-docs.js
 *
 * Triggered on PR merge to main. Classifies the change based on file paths,
 * PR labels, and PR title — tuned for: Shopify themes, Laravel + React,
 * Shopify apps, and WordPress.
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
  smallRefactorLines:  50,   // refactor ≤ this → one-line
  themeTemplateLines:  40,   // .liquid / WP theme ≤ this → one-line
  reactComponentLines: 50,   // .jsx/.tsx-only ≤ this → one-line
  stylingLines:        30,   // CSS-only ≤ this → one-line
  configMinLines:       5,   // config edits ≤ this → ignored (tiny version bumps)
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

// ─── PR context (from workflow env) ──────────────────────────────────────────

const repoName  = process.env.REPO_NAME     || 'unknown-repo';
const prNumber  = process.env.PR_NUMBER     || '?';
const prTitle   = process.env.PR_TITLE      || '(no title)';
const prBody    = process.env.PR_BODY       || '';
const prUrl     = process.env.PR_URL        || '';
const prAuthor  = process.env.PR_AUTHOR     || 'unknown';
const mergedAt  = process.env.PR_MERGED_AT  || new Date().toISOString();
const additions = parseInt(process.env.DIFF_ADDITIONS || '0', 10);
const deletions = parseInt(process.env.DIFF_DELETIONS || '0', 10);
const totalLines = additions + deletions;

let labels = [];
try {
  labels = JSON.parse(process.env.PR_LABELS || '[]').map(l => l.name.toLowerCase());
} catch (_) { /* keep empty */ }

const changedFiles = fs.existsSync('changed_files.txt')
  ? fs.readFileSync('changed_files.txt', 'utf8').trim()
  : '';
const codeDiff = fs.existsSync('code_diff.txt')
  ? fs.readFileSync('code_diff.txt', 'utf8').slice(0, CONFIG.diffMaxChars)
  : '';

const timestamp = mergedAt.replace('T', ' ').slice(0, 16) + ' UTC';
const filesArr  = changedFiles.split('\n').filter(Boolean);

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
  /(^|\/)database\/(migrations?|seeders?|seeds?|factories?)\//i.test(f) ||  // Laravel
  /(^|\/)(migrations?|seeds?)\//i.test(f) ||                                // generic
  /(^|\/)prisma\/(schema\.prisma|migrations\/)/i.test(f);                   // Shopify-app Remix

const isConfig = f =>
  /^\.env/i.test(f) ||
  /(^|\/)wp-config\.php$/i.test(f) ||                                       // WordPress
  /(^|\/)shopify\.(app|web|extension)\.toml$/i.test(f) ||                   // Shopify apps
  /(^|\/)composer\.(json|lock)$/i.test(f) ||                                // Laravel
  /(^|\/)package(-lock)?\.json$/i.test(f) ||
  /(^|\/)config\//i.test(f) ||                                              // Laravel config
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

const isBackend = f => isLaravelBackend(f) || isShopifyAppBackend(f) || isWordPressPlugin(f);

const isShopifyAPI = f =>
  /(^|\/)extensions\//i.test(f) ||                                          // Shopify checkout/UI extensions
  /shopify-api|admin-api|storefront-api/i.test(f) ||
  /(^|\/)app\/.*\.(graphql|gql)$/i.test(f);

const isLiquidTemplate = f => /\.liquid$/i.test(f);

const isWordPressTheme = f =>
  /(^|\/)wp-content\/themes\/.+\.php$/i.test(f) &&
  !/(^|\/)functions\.php$/i.test(f);    // functions.php is plugin-like, counted as backend

const isThemeTemplate = f => isLiquidTemplate(f) || isWordPressTheme(f);

const isReactComponent = f =>
  /\.(jsx|tsx)$/i.test(f) &&
  (/(^|\/)resources\/js\//i.test(f) || /(^|\/)src\//i.test(f) || /(^|\/)components?\//i.test(f));

const isStyling = f => /\.(css|scss|sass|less|styl)$/i.test(f);

// ─── Title keyword helpers ───────────────────────────────────────────────────

const titleHas = (...words) =>
  words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(prTitle));

// ─── Rule engine (matches scope document table) ──────────────────────────────

function classify() {
  // 1–2. Manual overrides
  if (labels.includes('skip-log'))     return { action: 'skip', reason: 'skip-log label' };
  if (labels.includes('log-detailed')) return { action: 'full', reason: 'log-detailed label' };

  // 3. Hotfix
  if (labels.includes('hotfix'))       return { action: 'full', reason: 'hotfix label', tag: 'HOTFIX' };

  // 4. Revert
  if (/^revert/i.test(prTitle))        return { action: 'full', reason: 'revert PR', tag: 'REVERT' };

  if (filesArr.length === 0) return { action: 'full', reason: 'no file list available — defaulting to full' };

  // 5. Documentation only
  if (filesArr.every(isDoc))
    return { action: 'oneline', reason: 'documentation-only update' };

  // 6. Translations only
  if (filesArr.every(isTranslation))
    return { action: 'oneline', reason: 'translations-only update' };

  // 7. Database / migrations
  if (filesArr.some(isDatabase))
    return { action: 'full', reason: 'database / migration change', tag: 'DB' };

  // 8. Environment / config
  if (filesArr.some(isConfig) && totalLines > CONFIG.configMinLines)
    return { action: 'full', reason: 'config update', tag: 'CONFIG' };

  // 9. Backend / server logic
  if (filesArr.some(isBackend))
    return { action: 'full', reason: 'backend / server logic change', tag: 'BACKEND' };

  // 10. Shopify checkout / API
  if (filesArr.some(isShopifyAPI))
    return { action: 'full', reason: 'Shopify checkout / API change', tag: 'SHOPIFY' };

  // 11. Bug fix
  if (labels.some(l => ['bug', 'bugfix', 'fix'].includes(l)) ||
      titleHas('fix', 'fixes', 'fixed', 'bug', 'bugfix', 'patch'))
    return { action: 'full', reason: 'bug fix', tag: 'FIX' };

  // 12. New feature
  if (labels.some(l => ['feature', 'feat', 'enhancement'].includes(l)) ||
      titleHas('feat', 'feature', 'add', 'added', 'adds', 'new', 'implement', 'introduce'))
    return { action: 'full', reason: 'new feature', tag: 'FEATURE' };

  // 13/17. Refactor (large vs small)
  if (titleHas('refactor', 'refactored', 'refactoring') || labels.includes('refactor')) {
    return totalLines > CONFIG.smallRefactorLines
      ? { action: 'full',    reason: `large refactor (${totalLines} lines)`, tag: 'REFACTOR' }
      : { action: 'oneline', reason: `small refactor (${totalLines} lines)` };
  }

  // 14. Theme template change (Shopify .liquid OR WordPress theme PHP)
  if (filesArr.every(isThemeTemplate)) {
    return totalLines > CONFIG.themeTemplateLines
      ? { action: 'full',    reason: `large theme template change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small theme template change (${totalLines} lines)` };
  }

  // 15. React component change
  if (filesArr.every(isReactComponent)) {
    return totalLines > CONFIG.reactComponentLines
      ? { action: 'full',    reason: `large React component change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small React component change (${totalLines} lines)` };
  }

  // 16. CSS / styling change
  if (filesArr.every(isStyling)) {
    return totalLines > CONFIG.stylingLines
      ? { action: 'full',    reason: `large CSS/styling change (${totalLines} lines)` }
      : { action: 'oneline', reason: `small CSS/styling change (${totalLines} lines)` };
  }

  // 18. Default
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
  return `Write a changelog entry for this merged pull request.

Repository: ${repoName}
PR #${prNumber}: ${prTitle}
Author: ${prAuthor}
Merged: ${timestamp}
URL: ${prUrl}
Labels: ${labels.join(', ') || 'none'}
Lines changed: +${additions} / -${deletions}

PR description:
${prBody || '(none)'}

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

function fullEntry(aiContent, tag) {
  const tagLine = tag ? `[${tag}]  ` : '';
  return [
    DIVIDER,
    `${tagLine}PR #${prNumber}: ${prTitle}`,
    `Author: ${prAuthor}    Merged: ${timestamp}`,
    `Labels: ${labels.join(', ') || 'none'}`,
    `Link: ${prUrl}`,
    `Files changed (${filesArr.length}): ${filesArr.join(', ') || 'none'}`,
    '',
    aiContent,
    '',
    '',
  ].join('\n');
}

function oneLineEntry(reason) {
  return `• [${timestamp}] PR #${prNumber} — ${prTitle} — ${prAuthor} (${reason}) — ${prUrl}\n\n`;
}

function fallbackEntry(errorMsg) {
  return [
    DIVIDER,
    `[NEEDS REVIEW]  PR #${prNumber}: ${prTitle}`,
    `Author: ${prAuthor}    Merged: ${timestamp}`,
    `Labels: ${labels.join(', ') || 'none'}`,
    `Link: ${prUrl}`,
    `Files changed (${filesArr.length}): ${filesArr.join(', ') || 'none'}`,
    '',
    `AI summary unavailable: ${errorMsg}`,
    'Please open the PR link above and add a manual summary if needed.',
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
  console.log(`Processing PR #${prNumber} in ${repoName}`);
  console.log(`  Title:  ${prTitle}`);
  console.log(`  Author: ${prAuthor}`);
  console.log(`  Lines:  +${additions} / -${deletions}  (total ${totalLines})`);
  console.log(`  Files:  ${filesArr.length}`);
  console.log(`  Labels: ${labels.join(', ') || 'none'}`);

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
