const baseUrl = process.env.SMOKE_BASE_URL || process.env.APP_URL;
const adminApiKey = process.env.SMOKE_ADMIN_API_KEY || process.env.ADMIN_API_KEY;
const smokeChatId = process.env.SMOKE_CHAT_ID;

if (!baseUrl) {
  console.error('SMOKE_BASE_URL or APP_URL is required');
  process.exit(1);
}

const normalizedBaseUrl = baseUrl.replace(/\/$/, '');

const checkJsonEndpoint = async (path, init) => {
  const response = await fetch(`${normalizedBaseUrl}${path}`, init);
  const text = await response.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON at ${path}: ${text}`);
  }

  return { response, json };
};

const run = async () => {
  const health = await checkJsonEndpoint('/health');
  if (!health.response.ok || health.json.status !== 'ok') {
    throw new Error(`Health check failed: status=${health.response.status}, body=${JSON.stringify(health.json)}`);
  }

  if (adminApiKey) {
    const queueHealth = await checkJsonEndpoint('/admin/queue/health', {
      headers: {
        'x-admin-key': adminApiKey
      }
    });

    if (!queueHealth.response.ok || queueHealth.json.ok !== true) {
      throw new Error(
        `Queue health check failed: status=${queueHealth.response.status}, body=${JSON.stringify(queueHealth.json)}`
      );
    }

    if (smokeChatId) {
      const reports = await checkJsonEndpoint(`/admin/reports/${encodeURIComponent(smokeChatId)}?limit=1`, {
        headers: {
          'x-admin-key': adminApiKey
        }
      });

      if (!reports.response.ok || reports.json.ok !== true || !Array.isArray(reports.json.reports)) {
        throw new Error(`Reports check failed: status=${reports.response.status}, body=${JSON.stringify(reports.json)}`);
      }
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: normalizedBaseUrl,
      checked: {
        health: true,
        admin: Boolean(adminApiKey),
        reports: Boolean(adminApiKey && smokeChatId)
      }
    })
  );
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});