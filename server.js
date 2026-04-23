import express from 'express';
import cors from 'cors';

const APACTA_BASE = 'https://app.apacta.com';
const PARTNER = `${APACTA_BASE}/api/v1`;
const INTERNAL = `${APACTA_BASE}/control-panel-api/v1`;

const FALLBACK_KEY =
  process.env.APACTA_API_KEY || '9f35c080-8556-4595-bfd0-2da0c071ee63';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

const PORT = process.env.PORT || 3000;

const OFFER_STATUS_TTL_MS = 10 * 60 * 1000;
const offerStatusCache = new Map();

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
  const cached = offerStatusCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.id;

  const r = await apacta(`${INTERNAL}/offer-statuses`, {
    headers: authHeaders(key),
  });
  if (!r.ok) return null;
  const list = r.data?.data || [];
  const byIdentifier = list.find(
    (s) => (s.identifier || '').toLowerCase() === 'draft'
  );
  const byName = list.find((s) =>
    ['draft', 'kladde'].includes((s.name || '').toLowerCase())
  );
  const id = byIdentifier?.id || byName?.id || list[0]?.id || null;

  if (id) {
    offerStatusCache.set(key, { id, expires: Date.now() + OFFER_STATUS_TTL_MS });
  }
  return id;
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

const ANALYZE_SYSTEM_PROMPT = `Du er en erfaren dansk VVS-mester hos Palne Klima & VVS. Du laver realistiske tilbud på VVS-opgaver ud fra en kort beskrivelse og evt. billeder fra montøren i marken.

Regler:
- Svar KUN med gyldig JSON — ingen forklaring, ingen markdown, ingen code fences.
- Alle priser er i DKK ekskl. moms (dansk moms er 25%).
- Timepris for VVS-arbejde er 695 DKK/time, medmindre opgaven tydeligt kræver andet.
- Materialer angives som separate line_items med realistiske danske priser.
- Arbejdstid angives som egne line_items (unit: "time").
- Hvis montøren nævner kørsel, læg et line_item til med unit: "stk" og beskrivende navn.
- Vær realistisk med mængder og tid — undgå at oversælge.
- Hvis opgaven er uklar, lav et fornuftigt gæt og nævn antagelserne i customer_message.

JSON-skema:
{
  "title": "Kort titel på tilbuddet (dansk)",
  "description": "2-4 sætninger om hvad opgaven omfatter (dansk)",
  "line_items": [
    {
      "name": "Navn på materiale eller arbejde",
      "description": "Valgfri uddybning",
      "quantity": 1,
      "unit": "stk" | "time" | "m" | "m²" | "sæt",
      "unit_price": 0,
      "product_id": null,
      "kind": "material" | "labor" | "other"
    }
  ],
  "customer_message": "En venlig personlig besked til kunden (dansk) med leveringstid, antagelser, og hvad der er inkluderet/ikke inkluderet."
}`;

function productCatalogSnippet(products) {
  if (!products?.length) return '';
  const sample = products.slice(0, 60).map((p) => ({
    id: p.id,
    name: p.name,
    unit: p.unit,
    price: p.sales_price,
  }));
  return `\n\nTilgængelige produkter i Apacta (brug gerne product_id hvis noget passer):\n${JSON.stringify(sample)}`;
}

app.post('/analyze', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY missing on server',
    });
  }

  const { description = '', products = [], images = [], model } = req.body || {};

  const textBlock =
    (description?.trim()
      ? `Opgavebeskrivelse fra montøren:\n"""${description.trim()}"""`
      : 'Montøren har ikke skrevet en beskrivelse — baser tilbuddet på vedhæftede billeder.') +
    (images.length
      ? `\n\n${images.length} billed${images.length === 1 ? '' : 'er'} af opgaven er vedhæftet — brug dem til at vurdere omfang og materialer.`
      : '') +
    productCatalogSnippet(products) +
    `\n\nLav et tilbud som JSON nu.`;

  const content = [];
  for (const img of images) {
    if (!img?.base64) continue;
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: normalizeImageMime(img.mime),
        data: img.base64,
      },
    });
  }
  content.push({ type: 'text', text: textBlock });

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || ANTHROPIC_MODEL,
        max_tokens: 2000,
        system: ANALYZE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    const text = await r.text();
    if (!r.ok) {
      return res.status(r.status).json({
        error: 'Claude request failed',
        upstream_status: r.status,
        upstream_body: text.slice(0, 1000),
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: 'Claude returned non-JSON', body: text.slice(0, 500) });
    }

    const rawText = (parsed?.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const offer = parseOfferJson(rawText);
    if (!offer) {
      return res.status(502).json({
        error: 'Could not parse Claude JSON',
        raw: rawText.slice(0, 800),
      });
    }

    res.json({ success: true, data: offer });
  } catch (err) {
    res.status(500).json({ error: 'analyze error', message: err?.message || String(err) });
  }
});

function normalizeImageMime(mime) {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (mime && allowed.includes(String(mime).toLowerCase())) {
    return String(mime).toLowerCase();
  }
  return 'image/jpeg';
}

function parseOfferJson(text) {
  if (!text) return null;
  let raw = text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    raw = raw.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      title: String(parsed.title || 'Tilbud'),
      description: String(parsed.description || ''),
      customer_message: String(parsed.customer_message || ''),
      line_items: Array.isArray(parsed.line_items)
        ? parsed.line_items.map(normalizeLine).filter((li) => li.name)
        : [],
    };
  } catch {
    return null;
  }
}

function normalizeLine(li) {
  const quantity = toNum(li.quantity, 1);
  const unit_price = toNum(li.unit_price, 0);
  const kind = ['material', 'labor', 'other'].includes(li.kind)
    ? li.kind
    : String(li.unit || '').toLowerCase() === 'time'
      ? 'labor'
      : 'material';
  return {
    name: String(li.name || '').trim(),
    description: String(li.description || ''),
    quantity,
    unit: String(li.unit || 'stk'),
    unit_price,
    product_id: li.product_id || null,
    kind,
    vat_percent: 25,
  };
}

function toNum(v, fallback) {
  if (v === null || v === undefined || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`palne-vvs-proxy listening on :${PORT}`);
});
