// Fonction Supabase « lire-ticket »
// À coller dans Supabase › Edge Functions › Deploy a new function › Via Editor
// Elle reçoit la photo d'un ticket, la fait lire par Claude et renvoie montant, date, commerçant, ville, catégorie.
// Seuls les utilisateurs connectés à votre app peuvent l'appeler (vérification JWT activée par défaut).

const CATEGORIES = ['hotel', 'restaurant', 'boulangerie', 'train', 'metro', 'taxi', 'carburant', 'peage', 'parking', 'avion', 'fournitures', 'autre', 'non_pris'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return json({ error: 'Clé ANTHROPIC_API_KEY absente des secrets Supabase' }, 500);
    const model = Deno.env.get('ANTHROPIC_MODEL') || 'claude-haiku-5-5';

    const { image, media_type = 'image/jpeg', today } = await req.json();
    if (!image || image.length > 7_000_000) return json({ error: 'Image absente ou trop lourde' }, 400);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        tools: [{
          name: 'enregistrer_ticket',
          description: "Enregistre les informations lues sur un justificatif de dépense professionnelle.",
          input_schema: {
            type: 'object',
            properties: {
              amount: { type: ['number', 'null'], description: 'Montant total TTC réellement payé, en euros (pas le HT, pas la TVA, pas un sous-total).' },
              date: { type: ['string', 'null'], description: 'Date de la dépense au format AAAA-MM-JJ.' },
              merchant: { type: ['string', 'null'], description: "Nom court du commerçant ou de l'enseigne, en casse normale (ex. « Ibis Part-Dieu »)." },
              city: { type: ['string', 'null'], description: 'Ville du commerçant si elle figure sur le ticket.' },
              category: { type: 'string', enum: CATEGORIES, description: "Catégorie de la dépense. metro = métro, bus, tram ; peage = autoroute ; fournitures = matériel, quincaillerie, bureau. non_pris = simple preuve de paiement qui n'est PAS une facture ni un ticket de caisse détaillé : reçu de carte bancaire « ticket client / à conserver », capture d'écran d'une application bancaire, de réservation (Booking, Airbnb…) ou de paiement (PayPal, Lydia) montrant seulement une transaction. Dans ce cas, renseigne quand même le montant, la date et le commerçant." }
            },
            required: ['amount', 'date', 'merchant', 'city', 'category']
          }
        }],
        tool_choice: { type: 'tool', name: 'enregistrer_ticket' },
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type, data: image } },
            { type: 'text', text: `Voici la photo d'un ticket ou d'une facture de déplacement professionnel en France. Nous sommes le ${today || 'jour inconnu'}. Lis-le et enregistre les informations. Si une information est illisible ou absente, mets null. Si ce n'est pas un justificatif de dépense, mets amount à null et category à "autre".` }
          ]
        }]
      })
    });
    const j = await r.json();
    if (!r.ok) return json({ error: j?.error?.message || `Erreur Claude ${r.status}` }, 502);
    const tool = (j.content || []).find((c: { type: string }) => c.type === 'tool_use');
    if (!tool) return json({ error: 'Réponse inattendue' }, 502);
    return json(tool.input);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});
