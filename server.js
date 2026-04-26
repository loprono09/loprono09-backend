require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const cors = require('cors');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors({ origin: '*' }));

// Webhook Stripe
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const plan = session.metadata?.plan || 'essentiel';

    if (email) {
      const password = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-4).toUpperCase() + '!';
      const name = session.customer_details?.name || email.split('@')[0];

      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email, password, email_confirm: true,
        user_metadata: { name, plan, role: 'user' }
      });

      if (!authError) {
        await supabase.from('members').insert({
          id: authData.user.id, email, name, plan,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          active: true, created_at: new Date().toISOString()
        });

        await resend.emails.send({
          from: 'LOPRONO09 <noreply@loprono09.fr>',
          to: email,
          subject: 'ðŸŽ‰ Bienvenue sur LOPRONO09 â€” Tes identifiants',
          html: `
            <div style="background:#0a0a0a;color:#fff;font-family:Arial,sans-serif;padding:40px;max-width:500px;margin:0 auto;border-radius:12px">
              <h1 style="color:#a3f000;font-size:28px;margin-bottom:8px">LOPRONO09</h1>
              <p style="color:#888;margin-bottom:24px">Pronos Sportifs Premium</p>
              <h2 style="font-size:20px;margin-bottom:16px">Bienvenue ${name} ! ðŸŽ‰</h2>
              <p style="color:#ccc;line-height:1.6;margin-bottom:24px">
                Ton abonnement <strong style="color:#a3f000">${plan === 'premium' ? 'Premium 19â‚¬/mois' : 'Essentiel 9â‚¬/mois'}</strong> est activÃ© !
              </p>
              <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;margin-bottom:24px">
                <p style="margin:0 0 8px"><strong>Email :</strong> ${email}</p>
                <p style="margin:0"><strong>Mot de passe :</strong> <span style="color:#a3f000;font-family:monospace;font-size:16px">${password}</span></p>
              </div>
              <a href="https://loprono09.fr" style="display:inline-block;background:#a3f000;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">
                AccÃ©der aux pronos â†’
              </a>
            </div>
          `
        });
        console.log(`âœ… Compte crÃ©Ã©: ${email}`);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await supabase.from('members').update({ active: false }).eq('stripe_subscription_id', subscription.id);
  }

  res.json({ received: true });
});

app.use(express.json());

// LOGIN
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const { data: member } = await supabase.from('members').select('*').eq('email', email).single();
  res.json({ user: { email, name: data.user.user_metadata?.name, plan: member?.plan, role: member?.role || 'user' }, token: data.session.access_token });
});

// GET PRONOS
app.get('/api/pronos', async (req, res) => {
  const { data, error } = await supabase.from('pronos').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ADD PRONO
app.post('/api/pronos', async (req, res) => {
  const { sport, competition, match, tip, cote, mise, type, result, prono_date } = req.body;
  if (!match || !tip || !cote) return res.status(400).json({ error: 'Champs manquants' });
  const { data, error } = await supabase.from('pronos').insert({
    sport, competition, match, tip,
    cote: parseFloat(cote),
    mise: mise ? parseFloat(mise) : null,
    type: type || 'free',
    result: result || 'pending',
    prono_date: prono_date || null
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// UPDATE PRONO
app.patch('/api/pronos/:id', async (req, res) => {
  const { data, error } = await supabase.from('pronos').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE PRONO
app.delete('/api/pronos/:id', async (req, res) => {
  const { error } = await supabase.from('pronos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

// FORGOT PASSWORD
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });

  // Check if user exists
  const { data: member } = await supabase.from('members').select('email').eq('email', email).single();
  if (!member) return res.status(404).json({ error: 'Email introuvable' });

  // Send reset email via Supabase Auth
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: 'https://loprono09.fr'
  });

  if (error) return res.status(500).json({ error: error.message });

  console.log(`ðŸ“§ Email de rÃ©initialisation envoyÃ© Ã  ${email}`);
  res.json({ success: true });
});

app.get('/', (req, res) => res.json({ status: 'LOPRONO09 Backend OK ðŸš€' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`âœ… Serveur LOPRONO09 dÃ©marrÃ© sur port ${PORT}`));
