import express from 'express';
import cors from 'cors';

const APACTA_BASE = 'https://app.apacta.com';
const PARTNER = `${APACTA_BASE}/api/v1`;
const INTERNAL = `${APACTA_BASE}/control-panel-api/v1`;

const FALLBACK_KEY =
  process.env.APACTA_API_KEY || '9f35c080-8556-4595-bfd0-2da0c071ee63';

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json({ limit: '30mb' }));

function apiKey(req) {
  return (
    req.header('x-apacta-api-key') ||
    req.header('authorization')?.replace(/^Bearer\s+/i, '') ||
    FALLBACK_KEY
  );
}

function authHeaders(key) {
  return {
    Authorization: key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function apacta(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, text, data };
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/products', async (req, res) => {
  const key = apiKey(req);
  const qs = new URLSearchParams(req.query).toString();
  const url = `${PARTNER}/products?${qs}`;
  const r = await apacta(url, { headers: authHeaders(key) });
  res.status(r.status).send(r.text);
});

app.get('/offer-statuses', async (req, res) => {
  const key = apiKey(req);
  const r = await apacta(`${INTERNAL}/offer-statuses`, {
    headers: authHeaders(key),
  });
  res.status(r.status).send(r.text);
});

app.get('/contacts', async (req, res) => {
  const key = apiKey(req);
  const qs = new URLSearchParams(req.query).toString();
  const r = await apacta(`${PARTNER}/contacts${qs ? `?${qs}` : ''}`, {
    headers: authHeaders(key),
  });
  res.status(r.status).send(r.text);
});

app.post('/contacts', async (req, res) => {
  const key = apiKey(req);
  const body = req.body || {};
  if (!body.name || !String(body.name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  const payload = {
    name: String(body.name).trim(),
  };
  if (body.email) payload.email = body.email;
  if (body.phone) payload.phone = body.phone;
  if (body.address) payload.address = body.address;
  if (body.cvr) payload.cvr = body.cvr;
  if (body.description) payload.description = body.description;
  if (body.website) payload.website = body.website;

  const r = await apacta(`${PARTNER}/contacts`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    return res.status(r.status).json({
      error: 'Apacta createContact failed',
      upstream_status: r.status,
      upstream_body: r.data || r.text?.slice(0, 1000),
    });
  }

  res.status(201).json(r.data || { success: true });
});

async function findDraftOfferStatusId(key) {
  const r = await apacta(`${INTERNAL}/offer-statuses`, {
    headers: authHeaders(key),
  });
  if (!r.ok) return null;
  const list = r.data?.data || [];
  const byIdentifier = list.find(
    (s) => (s.identifier || '').toLowerCase() === 'draft'
  );
  if (byIdentifier) return byIdentifier.id;
  const byName = list.find((s) =>
    ['draft', 'kladde'].includes((s.name || '').toLowerCase())
  );
  if (byName) return byName.id;
  return list[0]?.id || null;
}

app.post('/offers', async (req, res) => {
  const key = apiKey(req);
  const body = req.body || {};
  const {
    title,
    description,
    message,
    contact_id,
    project_id,
    offer_status_id,
    lines = [],
    is_draft,
  } = body;

  if (!title) {
    return res.status(400).json({ error: 'title is required' });
  }

  let statusId = offer_status_id;
  if (!statusId) {
    statusId = await findDraftOfferStatusId(key);
  }
  if (!statusId) {
    return res.status(500).json({
      error:
        'Could not resolve offer_status_id from Apacta. Pass offer_status_id explicitly.',
    });
  }

  const offerPayload = {
    title,
    description: description || '',
    offer_status_id: statusId,
    vat_percent: 25,
  };
  if (contact_id) offerPayload.contact_id = contact_id;
  if (project_id) offerPayload.project_id = project_id;

  const created = await apacta(`${INTERNAL}/offers`, {
    method: 'POST',
    headers: authHeaders(key),
    body: JSON.stringify(offerPayload),
  });

  if (!created.ok) {
    return res.status(created.status).json({
      error: 'Apacta createOffer failed',
      upstream_status: created.status,
      upstream_body: created.data || created.text?.slice(0, 1000),
    });
  }

  const offerId = created.data?.data?.id || created.data?.id;
  if (!offerId) {
    return res.status(502).json({
      error: 'Apacta did not return an offer id',
      upstream_body: created.data,
    });
  }

  const lineResults = [];
  for (const li of lines) {
    const linePayload = {
      offer_id: offerId,
      name: li.name,
      description: li.description || '',
      quantity: Number(li.quantity) || 0,
      selling_price: Number(li.selling_price ?? li.unit_price) || 0,
      product_unit: li.unit || 'stk',
      type: li.type || (li.kind === 'labor' ? 'user' : 'normal'),
    };
    if (li.product_id) linePayload.product_id = li.product_id;

    const lr = await apacta(`${INTERNAL}/offers/${offerId}/offer-lines`, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify(linePayload),
    });
    lineResults.push({
      name: li.name,
      ok: lr.ok,
      status: lr.status,
      error: lr.ok ? undefined : lr.data || lr.text?.slice(0, 500),
    });
  }

  if (message) {
    await apacta(`${INTERNAL}/offers/${offerId}`, {
      method: 'PATCH',
      headers: authHeaders(key),
      body: JSON.stringify({ description: message }),
    });
  }

  const allLinesOk = lineResults.every((x) => x.ok);

  res.status(201).json({
    success: allLinesOk,
    data: {
      id: offerId,
      lines_created: lineResults.filter((x) => x.ok).length,
      lines_failed: lineResults.filter((x) => !x.ok),
    },
    note: is_draft === false ? undefined : 'Offer created as draft',
  });
});

app.post('/offers/:id/files', async (req, res) => {
  const key = apiKey(req);
  const offerId = req.params.id;
  const files = Array.isArray(req.body?.files) ? req.body.files : [];

  if (!files.length) {
    return res.status(400).json({ error: 'No files provided' });
  }

  try {
    const form = new FormData();
    for (const f of files) {
      if (!f.data_base64) continue;
      const buf = Buffer.from(f.data_base64, 'base64');
      const blob = new Blob([buf], { type: f.mime || 'image/jpeg' });
      form.append('files[]', blob, f.name || `foto-${Date.now()}.jpg`);
    }

    const up = await fetch(`${INTERNAL}/offers/${offerId}/files`, {
      method: 'POST',
      headers: { Authorization: key },
      body: form,
    });

    const text = await up.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!up.ok) {
      return res.status(up.status).json({
        error: 'Apacta file upload failed',
        upstream_status: up.status,
        upstream_body: data || text?.slice(0, 1000),
      });
    }

    return res.status(200).json({
      success: true,
      data: data?.data || data,
      uploaded: files.length,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'file upload error',
      message: err?.message || String(err),
    });
  }
});

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`palne-vvs-proxy listening on :${PORT}`);
});
