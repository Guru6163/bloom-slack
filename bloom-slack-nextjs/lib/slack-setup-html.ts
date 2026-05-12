function escapeAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function buildSetupHtml(
  token: string,
  workspace: Record<string, unknown>,
  appBaseUrl: string,
): string {
  const teamName = String(workspace.team_name || 'your workspace');
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bloom Setup</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Inter, system-ui, sans-serif; background: #0a0a0a;
           color: #fff; display: flex; align-items: center; justify-content: center;
           min-height: 100vh; padding: 24px; }
    .card { background: #111; border: 1px solid #1f1f1f; border-radius: 16px;
            padding: 40px; max-width: 500px; width: 100%; }
    .header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
    .logo { font-size: 24px; font-weight: 700; color: #FF4500; }
    .workspace { font-size: 13px; color: #888; margin-bottom: 32px; }
    .step-label { font-size: 11px; color: #FF4500; font-weight: 600;
                  text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .step-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
    label { display: block; font-size: 12px; color: #888; margin-bottom: 6px; }
    input { width: 100%; background: #1f1f1f; border: 1px solid #2d2d2d;
            border-radius: 8px; color: #fff; padding: 10px 12px;
            font-size: 14px; outline: none; margin-bottom: 8px; }
    input:focus { border-color: #FF4500; }
    .btn { width: 100%; background: #FF4500; color: white; border: none;
           border-radius: 8px; padding: 12px; font-size: 14px;
           font-weight: 600; cursor: pointer; margin-top: 4px; }
    .btn:hover { background: #e03d00; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .link { color: #FF4500; font-size: 12px; text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .error { color: #ef4444; font-size: 12px; margin-top: 6px; display: none; }
    .success-state { display: none; text-align: center; padding: 32px 0; }
    .success-state .emoji { font-size: 48px; margin-bottom: 16px; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3);
               border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite;
               vertical-align: middle; margin-right: 6px; }
    @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div id="setup-form">
      <div class="header">
        <span class="logo">🌸 Bloom</span>
      </div>
      <div class="workspace">Connecting <strong>${escapeHtml(teamName)}</strong> to Bloom</div>

      <div class="step-label">Bloom API key</div>
      <div class="step-title">Connect your Bloom account</div>
      <p style="color:#888; font-size:13px; margin-bottom:14px; line-height:1.5;">
        Your Slack workspace stores the API key only. Pick a brand whenever you generate — in chat with @Bloom or with <code style="color:#ccc;">/bloom-gen generate … --brand &lt;id&gt;</code>.
      </p>
      <label>Bloom API Key</label>
      <input type="password" id="api-key-input" placeholder="bloom_sk_..." autocomplete="off" />
      <div class="error" id="key-error">Invalid API key. Try again.</div>
      <a href="https://trybloom.ai/developers" target="_blank" rel="noopener noreferrer" class="link">
        Get your key at trybloom.ai/developers →
      </a>
      <button class="btn" id="connect-btn" onclick="connectBloom()" style="margin-top: 16px;">
        Validate &amp; Connect →
      </button>
    </div>

    <div class="success-state" id="success-state">
      <div class="emoji">🎉</div>
      <h2 style="margin-bottom:12px;">Bloom is ready!</h2>
      <p style="color:#888; font-size:14px; line-height:1.6;">
        Mention <strong>@Bloom</strong> in Slack and name which brand to use (or paste its ID) when you want images.
      </p>
      <p style="color:#FF4500; font-size:13px; margin-top:20px; font-style:italic;">
        Try: "@Bloom for Acme: create a summer sale banner for Instagram, 16:9"
      </p>
    </div>
  </div>

  <script>
    const APP_BASE = '${escapeAttr(appBaseUrl)}';
    const TOKEN = '${escapeAttr(token)}';

    async function connectBloom() {
      const key = document.getElementById('api-key-input').value.trim();
      if (!key) return;
      const btn = document.getElementById('connect-btn');
      const error = document.getElementById('key-error');
      error.style.display = 'none';
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Connecting...';

      const validateRes = await fetch(APP_BASE + '/api/slack/setup/validate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key }),
      });
      const validateData = await validateRes.json();

      if (!validateData.valid) {
        error.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Validate & Connect →';
        return;
      }

      const saveRes = await fetch(APP_BASE + '/api/slack/setup/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, bloom_api_key: key }),
      });
      const saveData = await saveRes.json();

      if (saveData.success) {
        document.getElementById('setup-form').style.display = 'none';
        document.getElementById('success-state').style.display = 'block';
      } else {
        error.textContent = saveData.error || 'Save failed. Try again.';
        error.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Validate & Connect →';
      }
    }
  </script>
</body>
</html>`;
}
