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
  brandOnly: boolean,
  appBaseUrl: string,
): string {
  const teamName = String(workspace.team_name || 'your workspace');
  const brandId = String(workspace.brand_id || '');
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
    .step { margin-bottom: 28px; }
    .step-label { font-size: 11px; color: #FF4500; font-weight: 600; 
                  text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
    .step-title { font-size: 15px; font-weight: 600; margin-bottom: 12px; }
    label { display: block; font-size: 12px; color: #888; margin-bottom: 6px; }
    input { width: 100%; background: #1f1f1f; border: 1px solid #2d2d2d; 
            border-radius: 8px; color: #fff; padding: 10px 12px; 
            font-size: 14px; outline: none; margin-bottom: 8px; }
    input:focus { border-color: #FF4500; }
    input:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn { width: 100%; background: #FF4500; color: white; border: none; 
           border-radius: 8px; padding: 12px; font-size: 14px; 
           font-weight: 600; cursor: pointer; margin-top: 4px; }
    .btn:hover { background: #e03d00; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-secondary { background: #1f1f1f; border: 1px solid #2d2d2d; }
    .btn-secondary:hover { background: #2a2a2a; }
    .link { color: #FF4500; font-size: 12px; text-decoration: none; }
    .link:hover { text-decoration: underline; }
    .error { color: #ef4444; font-size: 12px; margin-top: 6px; display: none; }
    .success-state { display: none; text-align: center; padding: 32px 0; }
    .success-state .emoji { font-size: 48px; margin-bottom: 16px; }
    .brand-list { display: none; margin-top: 12px; }
    .brand-item { background: #1f1f1f; border: 1px solid #2d2d2d; 
                  border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; 
                  cursor: pointer; display: flex; align-items: center; gap: 10px; }
    .brand-item:hover { border-color: #FF4500; }
    .brand-item.selected { border-color: #FF4500; background: #1a0d00; }
    .brand-item .check { color: #FF4500; font-size: 16px; opacity: 0; }
    .brand-item.selected .check { opacity: 1; }
    .brand-name { font-weight: 600; font-size: 14px; }
    .brand-url { font-size: 12px; color: #888; }
    .divider { height: 1px; background: #1f1f1f; margin: 24px 0; }
    .current-badge { display: inline-block; background: #FF4500; color: white; 
                     font-size: 10px; padding: 2px 6px; border-radius: 4px; 
                     font-weight: 600; margin-left: 8px; vertical-align: middle; }
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
      <div class="workspace">Setting up for <strong>${escapeHtml(teamName)}</strong></div>

      ${!brandOnly ? `
      <div class="step" id="step-api-key">
        <div class="step-label">Step 1 of 2</div>
        <div class="step-title">Connect your Bloom account</div>
        <label>Bloom API Key</label>
        <input type="password" id="api-key-input" placeholder="bloom_sk_..." />
        <div class="error" id="key-error">Invalid API key. Try again.</div>
        <a href="https://trybloom.ai/developers" target="_blank" class="link">
          Get your key at trybloom.ai/developers →
        </a>
        <button class="btn" id="validate-btn" onclick="validateKey()" style="margin-top: 16px;">
          Validate & Continue →
        </button>
      </div>
      ` : `
      <div class="step">
        <div class="step-title">Change your brand</div>
        <p style="color:#888; font-size:13px; margin-bottom:16px;">
          Your Bloom account is connected. Select a different brand below.
        </p>
        <div id="brand-list" class="brand-list" style="display:block;">
          <div style="color:#888; font-size:13px;">Loading your brands...</div>
        </div>
        <div class="error" id="brand-error">Please select a brand.</div>
        <button class="btn" id="save-btn" onclick="saveBrand()" style="margin-top:16px;" disabled>
          Save Brand →
        </button>
      </div>
      `}

      ${!brandOnly ? `
      <div id="step-brand" style="display:none;">
        <div class="divider"></div>
        <div class="step-label">Step 2 of 2</div>
        <div class="step-title">Select your brand</div>
        <div id="brand-list-step2" class="brand-list" style="display:block;">
          <div style="color:#888; font-size:13px;">Loading your brands...</div>
        </div>
        <div class="error" id="brand-error-step2">Please select a brand.</div>
        <button class="btn" id="save-btn-step2" onclick="saveBrandStep2()" style="margin-top:16px;" disabled>
          Save & Start Using Bloom →
        </button>
      </div>
      ` : ''}
    </div>

    <div class="success-state" id="success-state">
      <div class="emoji">🎉</div>
      <h2 style="margin-bottom:12px;">Bloom is ready!</h2>
      <p style="color:#888; font-size:14px; line-height:1.6;">
        Go to any Slack channel and mention <strong>@Bloom</strong> to start generating on-brand images.
      </p>
      <p style="color:#FF4500; font-size:13px; margin-top:20px; font-style:italic;">
        Try: "@Bloom create a summer sale banner for Instagram"
      </p>
    </div>
  </div>

  <script>
    const APP_BASE = '${escapeAttr(appBaseUrl)}';
    const TOKEN = '${escapeAttr(token)}';
    const BRAND_ONLY = ${brandOnly};
    const CURRENT_BRAND_ID = '${escapeAttr(brandId)}';
    let selectedBrand = null;
    let validatedApiKey = null;

    function brandListEl() {
      if (BRAND_ONLY) return document.getElementById('brand-list');
      return document.getElementById('brand-list-step2');
    }
    function brandErrorEl() {
      if (BRAND_ONLY) return document.getElementById('brand-error');
      return document.getElementById('brand-error-step2');
    }
    function saveBtnEl() {
      if (BRAND_ONLY) return document.getElementById('save-btn');
      return document.getElementById('save-btn-step2');
    }

    ${brandOnly ? `window.onload = () => loadBrandsWithToken();` : ''}

    async function validateKey() {
      const key = document.getElementById('api-key-input').value.trim();
      if (!key) return;
      const btn = document.getElementById('validate-btn');
      const error = document.getElementById('key-error');
      error.style.display = 'none';
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Validating...';

      const res = await fetch(APP_BASE + '/api/slack/setup/validate-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: key }),
      });
      const data = await res.json();

      if (!data.valid) {
        error.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Validate & Continue →';
        return;
      }

      validatedApiKey = key;
      document.getElementById('step-api-key').style.display = 'none';
      document.getElementById('step-brand').style.display = 'block';
      renderBrands(data.brands, brandListEl());
    }

    async function loadBrandsWithToken() {
      const res = await fetch(APP_BASE + '/api/slack/setup/brands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: TOKEN }),
      });
      const data = await res.json();
      if (data.valid) renderBrands(data.brands, brandListEl());
      else brandListEl().innerHTML = '<p style="color:#ef4444;font-size:13px;">Could not load brands. Re-open the setup link from Slack.</p>';
    }

    function renderBrands(brands, list) {
      list.innerHTML = '';
      if (!brands.length) {
        list.innerHTML = '<p style="color:#888;font-size:13px;">No brands found. Add one at trybloom.ai</p>';
        return;
      }
      brands.forEach(brand => {
        const item = document.createElement('div');
        item.className = 'brand-item';
        const isCurrent = String(brand.id) === CURRENT_BRAND_ID;
        item.innerHTML = \`
          <span class="check">✓</span>
          <div>
            <div class="brand-name">\${brand.name}\${isCurrent ? '<span class="current-badge">current</span>' : ''}</div>
            <div class="brand-url">\${brand.url || ''}</div>
          </div>
        \`;
        item.onclick = () => {
          list.querySelectorAll('.brand-item').forEach(el => el.classList.remove('selected'));
          item.classList.add('selected');
          selectedBrand = brand;
          saveBtnEl().disabled = false;
        };
        list.appendChild(item);
      });
    }

    async function saveBrand() {
      return saveBrandCommon();
    }
    async function saveBrandStep2() {
      return saveBrandCommon();
    }

    async function saveBrandCommon() {
      if (!selectedBrand) return;
      const btn = saveBtnEl();
      const error = brandErrorEl();
      error.style.display = 'none';
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>Saving...';

      const brandSessionId = selectedBrand.brandSessionId ||
                             selectedBrand.brand_session_id ||
                             selectedBrand.id;

      const res = await fetch(APP_BASE + '/api/slack/setup/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: TOKEN,
          bloom_api_key: BRAND_ONLY ? null : validatedApiKey,
          brand_id: selectedBrand.id,
          brand_name: selectedBrand.name,
          brand_session_id: brandSessionId,
        }),
      });
      const data = await res.json();

      if (data.success) {
        document.getElementById('setup-form').style.display = 'none';
        document.getElementById('success-state').style.display = 'block';
      } else {
        error.textContent = data.error || 'Save failed. Try again.';
        error.style.display = 'block';
        btn.disabled = false;
        btn.textContent = BRAND_ONLY ? 'Save Brand →' : 'Save & Start Using Bloom →';
      }
    }
  </script>
</body>
</html>`;
}
