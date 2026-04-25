require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const cors = require('cors');

const app = express();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

app.use(cors({ origin: ['https://loprono09.fr', 'https://www.loprono09.fr'] }));

// Webhook Stripe — doit être AVANT express.json()
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email;
    const plan = session.metadata?.plan || 'essentiel';

    if (email) {
      // Générer un mot de passe aléatoire
      const password = Math.random().toString(36).slice(-10) + Math.random().toString(36).slice(-4).toUpperCase() + '!';
      const name = session.customer_details?.name || email.split('@')[0];

      // Créer le compte dans Supabase Auth
      const { data: authData, error: authError } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { name, plan, role: 'user' }
      });

      if (authError) {
        console.error('Supabase auth error:', authError);
      } else {
        // Sauvegarder dans la table members
        await supabase.from('members').insert({
          id: authData.user.id,
          email,
          name,
          plan,
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          active: true,
          created_at: new Date().toISOString()
        });

        // Envoyer email de bienvenue avec identifiants
        await resend.emails.send({
          from: 'LOPRONO09 <noreply@loprono09.fr>',
          to: email,
          subject: '🎉 Bienvenue sur LOPRONO09 — Tes identifiants',
          html: `
            <div style="background:#0a0a0a;color:#fff;font-family:Arial,sans-serif;padding:40px;max-width:500px;margin:0 auto;border-radius:12px">
              <h1 style="color:#a3f000;font-size:28px;margin-bottom:8px">LOPRONO09</h1>
              <p style="color:#888;margin-bottom:24px">Pronos Sportifs Premium</p>
              <h2 style="font-size:20px;margin-bottom:16px">Bienvenue ${name} ! 🎉</h2>
              <p style="color:#ccc;line-height:1.6;margin-bottom:24px">
                Ton abonnement <strong style="color:#a3f000">${plan === 'premium' ? 'Premium 19€/mois' : 'Essentiel 9€/mois'}</strong> est activé !
                Voici tes identifiants pour accéder aux pronos VIP :
              </p>
              <div style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:20px;margin-bottom:24px">
                <p style="margin:0 0 8px"><strong>Email :</strong> ${email}</p>
                <p style="margin:0"><strong>Mot de passe :</strong> <span style="color:#a3f000;font-family:monospace;font-size:16px">${password}</span></p>
              </div>
              <a href="https://loprono09.fr" style="display:inline-block;background:#a3f000;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin-bottom:24px">
                Accéder aux pronos →
              </a>
              <p style="color:#555;font-size:12px">Tu peux changer ton mot de passe une fois connecté. En cas de problème réponds à cet email.</p>
            </div>
          `
        });

        console.log(`✅ Compte créé et email envoyé à ${email} (plan: ${plan})`);
      }
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await supabase.from('members')
      .update({ active: false })
      .eq('stripe_subscription_id', subscription.id);
    console.log(`❌ Abonnement annulé: ${subscription.id}`);
  }

  res.json({ received: true });
});

app.use(express.json());

// API — Vérifier si un membre est actif
app.post('/api/check-member', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  const { data } = await supabase.from('members').select('*').eq('email', email).eq('active', true).single();
  res.json({ active: !!data, plan: data?.plan || null });
});

// API — Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
  const { data: member } = await supabase.from('members').select('*').eq('email', email).single();
  res.json({ user: { email, name: data.user.user_metadata?.name, plan: member?.plan, role: member?.role || 'user' }, token: data.session.access_token });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'LOPRONO09 Backend OK 🚀' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Serveur LOPRONO09 démarré sur port ${PORT}`));
