const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

const APACTA_BASE = 'https://app.apacta.com/api/v1';
const API_KEY = '9f35c080-8556-4595-bfd0-2da0c071ee63';

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// GET produkter
app.get('/products', async (req, res) => {
  try {
    const query = req.query.name ? `&name=${req.query.name}` : '';
    const r = await fetch(`${APACTA_BASE}/products?api_key=${API_KEY}&limit=100${query}`);
    const json = await r.json();
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST opret tilbud - prøver begge auth metoder
app.post('/invoices', async (req, res) => {
  try {
    console.log('Opretter tilbud:', JSON.stringify(req.body));
    
    // Prøv med Bearer token
    const r = await fetch(`${APACTA_BASE}/invoices`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'X-Auth-Token': API_KEY,
      },
      body: JSON.stringify(req.body),
    });
    
    const text = await r.text();
    console.log('Apacta HTTP status:', r.status);
    console.log('Apacta svar:', text.substring(0, 500));
    
    if (text.startsWith('<')) {
      // Prøv med api_key i URL som fallback
      const r2 = await fetch(`${APACTA_BASE}/invoices?api_key=${API_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
      });
      const text2 = await r2.text();
      console.log('Fallback svar:', text2.substring(0, 500));
      res.status(r2.status).send(text2);
      return;
    }
    
    res.status(r.status).send(text);
  } catch (err) {
    console.error('Fejl:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST tilføj linjer
app.post('/invoices/:id/invoice_lines', async (req, res) => {
  try {
    const r = await fetch(`${APACTA_BASE}/invoices/${req.params.id}/invoice_lines?api_key=${API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const text = await r.text();
    console.log('Linje svar:', text.substring(0, 300));
    res.status(r.status).send(text);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy kører på port ${PORT}`));
