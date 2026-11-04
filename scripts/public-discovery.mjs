import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const escape = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
export const publicPages = [
  {
    path: 'discover/',
    page: 'home',
    title: 'A workspace for your data and AI agents',
    description:
      'Explore files, run SQL, and give your agent scoped access to a shared data workspace.',
    heading: 'From a question to a useful result.',
    body: '<p class="lead">Keep files, PostgreSQL-compatible databases, and agent access in one workspace. Explore a sales sample yourself, or let your agent work with the same data.</p><div class="cards"><section><h2>Start with a real example</h2><p>Compare sales by state, explore the leading products, and save your findings. Follow the guide without installing an agent.</p></section><section><h2>Bring your agent</h2><p>Create a Workspace Key with the actions and resources your agent needs. Connect through the documented API.</p></section><section><h2>Return to your work</h2><p>Keep results in your workspace and continue from your files and tutorials. Temporary workspaces have a 24-hour access limit.</p></section></div><p>Availability depends on the configured region and providers. PostgreSQL is opt-in; File System analysis uses supported SQL and read-only shell tools. Persistent TiDB Cloud Starter integration is planned.</p>',
  },
  {
    path: 'discover/get-started/',
    page: 'get_started',
    title: 'Get started with a data workspace',
    description:
      'Try a temporary data workspace, explore the sales sample, and connect an agent with a scoped Workspace Key.',
    heading: 'Get your first useful result.',
    body: '<ol><li><h2>Open a temporary workspace</h2><p>Choose “Try without an account” in the Console. Access lasts 24 hours. Sign in with your TiDB Account for an account workspace.</p></li><li><h2>Explore the sales sample</h2><p>Choose the US sales sample. The workspace prepares a File System and saves the sample there. Select the self-service or agent path.</p></li><li><h2>Ask a concrete question</h2><p>Which state has the most sales? Compare the actual results, then explore the leading state’s products.</p></li><li><h2>Save and continue</h2><p>Save your findings as a report. Reopen the file to inspect the result. For agent work, create a Workspace Key with explicit action and resource permissions.</p></li></ol><p>Temporary access expires. Do not treat a temporary workspace as a permanent home for important data. Provider availability and limits are shown in the Console.</p>',
  },
  {
    path: 'discover/analyze-sales-data/',
    page: 'sales_guide',
    title: 'Analyze sales data with SQL or an AI agent',
    description:
      'A worked path from a CSV sales sample to a saved report: compare states, investigate products, and verify the results.',
    heading: 'Find the story in a sales dataset.',
    body: '<p class="lead">Use the built-in US sales sample to answer two questions: which state leads sales, and which products drive that result?</p><h2>What you need</h2><p>A workspace and its built-in sales sample. The sample is saved in your File System. The self-service path does not require installing an agent or creating a key.</p><h2>Compare sales by state</h2><p>Open the sample journey and run the state comparison. Review the totals from the actual dataset; identify the leading state from those results.</p><h2>Investigate the leader</h2><p>Run the product breakdown for that state. Check the leading products and their contributions before drawing a conclusion.</p><h2>Keep a verifiable report</h2><p>Save the report explicitly, then open the saved file. Re-entry should offer your existing result rather than overwrite it.</p><h2>Use an agent for the same question</h2><p>Switch to the agent path and grant a Workspace Key access only to the required resources and actions. Ask the agent to save its findings and inspect the resulting files. Copying a key is not evidence that an agent completed the task.</p><h2>Limits</h2><p>Analysis is scoped to selected files and supported engines. Large or unsupported inputs may require another workflow. The Console shows actual errors and recovery options.</p>',
  },
  {
    path: 'discover/api/',
    page: 'api_docs',
    title: 'API access for developers and AI agents',
    description:
      'Connect an agent to the workspace API with explicit resource and action permissions and current OpenAPI documentation.',
    heading: 'One Workspace Key. Explicit access.',
    body: '<p class="lead">Developers and agents use documented APIs for resources, files, database queries, analysis, imports, and exports.</p><h2>Connect</h2><ol><li>Open the Console and create a Workspace Key.</li><li>Select only the required actions and resources, then choose an expiration.</li><li>Use the endpoint and agent instructions shown with the key.</li><li>Run one read request before starting a larger workflow.</li></ol><h2>Discover the current contract</h2><p>The Console’s API documentation provides the active endpoint, OpenAPI contract, and copyable examples. The contract is generated from the same repository as the service. Use the deployed contract rather than assuming a tutorial reflects every region’s capabilities.</p><h2>Keep credentials private</h2><p>The service manages upstream provider credentials. A Workspace Key does not grant account administration or access to other workspaces. Revoke it in the Console when it is no longer needed.</p>',
  },
  {
    path: 'discover/privacy/',
    page: 'privacy',
    title: 'Usage analytics and your choices',
    description:
      'What optional product analytics records, what it excludes, and how to turn it off.',
    heading: 'Measure the product. Keep your data private.',
    body: '<h2>What optional analytics records</h2><p>Page categories, approved campaign labels, broad referral categories, selected journeys, and yes/no feedback. A random session identifier expires after 30 minutes of inactivity. It is not used for cross-site tracking.</p><h2>What stays out</h2><p>SQL, file names and contents, query results, credentials, full page URLs, raw referrers, keystrokes, and session recordings are excluded from product analytics.</p><h2>Service outcomes</h2><p>The service separately measures completed product actions using anonymous workspace identifiers, so API use is visible alongside Console use. Security and request diagnostics are separate from optional browser analytics.</p><h2>Retention and access</h2><p>Analytics detail is retained for up to 30 days and identity-free daily totals for up to 90 days. Authorized administrators see aggregate usage, not your files or queries.</p><h2>Your choice</h2><p>Turn optional browser analytics off here or in the Console. Global Privacy Control also disables optional browser collection.</p><button id="analytics-choice" type="button">Turn optional analytics off</button><p id="analytics-choice-status" role="status"></p>',
  },
];
export function discoveryFiles({ base = '/', origin = '', script = '' } = {}) {
  if (!base.startsWith('/') || !base.endsWith('/') || base.includes('..'))
    throw new Error('Invalid discovery base.');
  let canonicalBase = '';
  if (origin) {
    const url = new URL(origin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.replace(/\/$/, '') !== base.replace(/\/$/, '')
    )
      throw new Error('Public site URL must be HTTPS and match the Console base.');
    canonicalBase = url.href.replace(/\/$/, '') + '/';
  }
  const files = {};
  for (const page of publicPages) {
    const canonical = canonicalBase ? canonicalBase + page.path : '';
    const links = `<nav aria-label="Main"><a class="brand" href="${base}discover/">Drive9 Workspace</a><div><a href="${base}discover/get-started/">Get started</a><a href="${base}discover/analyze-sales-data/">Sales guide</a><a href="${base}discover/api/">API</a></div></nav>`;
    files[page.path + 'index.html'] =
      `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(page.title)} · Drive9 Workspace</title><meta name="description" content="${escape(page.description)}"><meta name="robots" content="${canonical ? 'index,follow' : 'noindex,follow'}">${canonical ? `<link rel="canonical" href="${escape(canonical)}"><meta property="og:url" content="${escape(canonical)}">` : ''}<meta property="og:type" content="website"><meta property="og:title" content="${escape(page.title)}"><meta property="og:description" content="${escape(page.description)}"><meta name="twitter:card" content="summary"><meta name="color-scheme" content="light dark"><style>body{margin:0;font:18px/1.65 system-ui,sans-serif;color:#162b2b;background:#f8faf9}nav,main,footer{max-width:1040px;margin:auto;padding:28px}nav{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}nav div{display:flex;gap:22px;flex-wrap:wrap}a{color:#086d63;text-underline-offset:4px}.brand{font-weight:750;text-decoration:none}main{padding-top:64px;padding-bottom:80px}h1{font-size:clamp(38px,6vw,68px);line-height:1.1;letter-spacing:-.04em;max-width:860px;margin:20px 0 32px}h2{font-size:25px;line-height:1.25;margin-top:40px}.lead{font-size:24px;max-width:800px;color:#42605a}p,li{max-width:800px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin:42px 0}.cards section{border:1px solid #ccdad6;border-radius:16px;padding:22px}.cards h2{margin-top:0}.cta,button{display:inline-block;background:#086d63;color:white;padding:13px 22px;border:0;border-radius:9px;font:inherit;text-decoration:none;cursor:pointer}footer{border-top:1px solid #ccdad6;font-size:15px}a:focus-visible,button:focus-visible{outline:3px solid #e5a83e;outline-offset:4px}@media(max-width:700px){.cards{grid-template-columns:1fr}nav,main,footer{padding:22px}.lead{font-size:21px}}@media(prefers-color-scheme:dark){body{background:#111c1b;color:#e1eeeb}.lead{color:#adc6bf}a{color:#82d8c5}.cta,button{background:#82d8c5;color:#102820}.cards section,footer{border-color:#39524b}}</style></head><body data-page="${page.page}" data-base="${base}">${links}<main><p>Files · PostgreSQL · Agents</p><h1>${page.heading}</h1>${page.body}${page.page === 'privacy' ? '' : `<p><a class="cta" data-analytics="try" href="${base}">Try without an account</a></p><p>Temporary workspace access lasts 24 hours. Availability depends on the deployment.</p>`}</main><footer><a href="${base}discover/privacy/">Privacy and analytics choices</a> · <a href="${base}">Open Console</a></footer>${script ? `<script type="module" src="${base}${script}"></script>` : ''}</body></html>`;
  }
  files['sitemap.xml'] =
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${canonicalBase ? publicPages.map((p) => `<url><loc>${escape(canonicalBase + p.path)}</loc></url>`).join('') : ''}</urlset>`;
  files['robots.txt'] =
    `User-agent: *\nAllow: ${base}discover/\nDisallow: ${base}api/\n${canonicalBase ? `Sitemap: ${canonicalBase}sitemap.xml\n` : '# Preview HTML uses noindex.\n'}`;
  files['llms.txt'] =
    `# Drive9 Workspace\n\nA data workspace for developers and agents. PostgreSQL-compatible databases and File Systems depend on deployment availability.\n\n${publicPages
      .filter((p) => p.page !== 'privacy')
      .map((p) => `- [${p.title}](${canonicalBase || base}${p.path}): ${p.description}`)
      .join('\n')}\n`;
  return files;
}
export function publicDiscoveryPlugin() {
  let base = '/';
  return {
    name: 'public-discovery',
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_, bundle) {
      const entry = Object.values(bundle).find(
        (item) => item.type === 'chunk' && item.name === 'discovery',
      );
      for (const [fileName, source] of Object.entries(
        discoveryFiles({
          base,
          origin: process.env.WORKSPACE_PUBLIC_SITE_URL || '',
          script: entry?.fileName || '',
        }),
      ))
        this.emitFile({ type: 'asset', fileName, source });
    },
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  throw new Error('Use the Console build to generate discovery pages.');
