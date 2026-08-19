import { query, getClient } from "../db.js";
import { loadEnrichedSubmissions, getContactRecord } from "./contacts.js";
import { listCallsForContact } from "./calls.js";
import { listContactNotes, listConversationsForExport } from "./conversations.js";

// Diritti GDPR (accesso/portabilità art. 15/20, cancellazione art. 17) su
// tutti i dati collegati a un'email in un sito: sono sparsi su più tabelle
// (form_submissions, contacts, calls, newsletter_subscribers) senza una FK
// comune (l'email è l'unica chiave di collegamento, dedotta per i form
// scritti a mano — vedi services/contacts.js) — questo modulo li raccoglie
// in un unico punto invece di lasciare che ogni richiesta venga gestita a
// mano rovistando nel database.

async function findFormSubmissionIds(siteId, normalizedEmail) {
  // limit: null → TUTTE le submission del sito, non solo le ultime 5000:
  // per i diritti GDPR l'export/la cancellazione parziale è una violazione
  // silenziosa (dati più vecchi che restano in giro senza alcun warning).
  const submissions = await loadEnrichedSubmissions(siteId, { limit: null });
  return submissions.filter(s => s.email === normalizedEmail);
}

export async function exportContactData(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();

  const [contact, formSubmissions, calls, subscriber, notes, conversations, opportunities, quotes, followupRuns, replySuggestions, paymentLinks] = await Promise.all([
    getContactRecord(siteId, normalized),
    findFormSubmissionIds(siteId, normalized),
    listCallsForContact(siteId, normalized),
    query(
      "SELECT email, status, subscribed_at, confirmed_at, unsubscribed_at FROM newsletter_subscribers WHERE site_id = $1 AND email = $2",
      [siteId, normalized]
    ).then(r => r.rows[0] || null),
    listContactNotes(siteId, normalized),
    listConversationsForExport(siteId, normalized),
    query(
      "SELECT id, pipeline_id, stage, title, amount, probability, status, expected_close_at, notes, created_at FROM opportunities WHERE site_id = $1 AND contact_email = $2",
      [siteId, normalized]
    ).then(r => r.rows),
    query(
      "SELECT quote_number, title, items, notes, status, sent_at, viewed_at, signed_at, created_at FROM quotes WHERE site_id = $1 AND contact_email = $2",
      [siteId, normalized]
    ).then(r => r.rows),
    query(
      "SELECT rule_id, action, status, created_at FROM followup_runs WHERE site_id = $1 AND email = $2",
      [siteId, normalized]
    ).then(r => r.rows),
    query(
      "SELECT conversation_id, suggested_text, source, status, created_at FROM reply_suggestions WHERE site_id = $1 AND contact_email = $2",
      [siteId, normalized]
    ).then(r => r.rows),
    query(
      "SELECT title, amount, currency, description, status, stripe_url, created_at, paid_at FROM payment_links WHERE site_id = $1 AND contact_email = $2",
      [siteId, normalized]
    ).then(r => r.rows),
  ]);

  return {
    email: normalized,
    exported_at: new Date().toISOString(),
    contact: { tags: contact.tags, status: contact.status, notes: contact.notes, value_estimate: contact.value_estimate },
    form_submissions: formSubmissions.map(s => ({ form_slug: s.form_slug, data: s.data, submitted_at: s.created_at })),
    calls: calls.map(c => ({ scheduled_at: c.scheduled_at, duration_minutes: c.duration_minutes, status: c.status, outcome_notes: c.outcome_notes })),
    newsletter_subscription: subscriber,
    notes: notes.map(n => ({ author_type: n.author_type, author_name: n.author_name, body: n.body, created_at: n.created_at })),
    conversations: conversations.map(c => ({
      channel: c.channel, status: c.status, subject: c.subject, created_at: c.created_at,
      messages: c.messages.map(m => ({ direction: m.direction, subject: m.subject, body: m.body, created_at: m.created_at })),
    })),
    opportunities: opportunities.map(o => ({ id: o.id, pipeline_id: o.pipeline_id, stage: o.stage, title: o.title, amount: o.amount, probability: o.probability, status: o.status, expected_close_at: o.expected_close_at, notes: o.notes, created_at: o.created_at })),
    quotes: quotes.map(q => ({ quote_number: q.quote_number, title: q.title, items: q.items, notes: q.notes, status: q.status, sent_at: q.sent_at, viewed_at: q.viewed_at, signed_at: q.signed_at, created_at: q.created_at })),
    followup_runs: followupRuns.map(f => ({ rule_id: f.rule_id, action: f.action, status: f.status, created_at: f.created_at })),
    reply_suggestions: replySuggestions.map(s => ({ conversation_id: s.conversation_id, suggested_text: s.suggested_text, source: s.source, status: s.status, created_at: s.created_at })),
    payment_links: paymentLinks.map(p => ({ title: p.title, amount: p.amount, currency: p.currency, description: p.description, status: p.status, stripe_url: p.stripe_url, created_at: p.created_at, paid_at: p.paid_at })),
  };
}

// Cancellazione reale (non anonimizzazione): le righe vengono eliminate, non
// mascherate — coerente con l'aspettativa dell'art. 17 GDPR ("cancellati").
// newsletter_sends/newsletter_sequence_sends si puliscono da soli (FK
// ON DELETE CASCADE su newsletter_subscribers, vedi db/018_newsletter.sql).
export async function eraseContactData(siteId, email) {
  const normalized = String(email || "").trim().toLowerCase();

  const submissionIds = (await findFormSubmissionIds(siteId, normalized)).map(s => s.id);
  const deleted = { form_submissions: 0, calls: 0, contact: 0, newsletter_subscriber: 0, notes: 0, conversations: 0, opportunities: 0, quotes: 0, followup_runs: 0, reply_suggestions: 0, payment_links: 0 };

  // Tutto in una transazione: prima un errore a metà lasciava una
  // cancellazione parziale (es. form cancellati ma contatto ancora presente)
  // senza alcun segnale all'operatore — peggio di non cancellare nulla per
  // una richiesta art. 17, perché sembra completata.
  const client = await getClient();
  try {
    await client.query("BEGIN");
    if (submissionIds.length > 0) {
      const result = await client.query("DELETE FROM form_submissions WHERE id = ANY($1)", [submissionIds]);
      deleted.form_submissions = result.rowCount;
    }
    deleted.calls = (await client.query("DELETE FROM calls WHERE site_id = $1 AND email = $2", [siteId, normalized])).rowCount;
    // conversation_messages si elimina da solo (ON DELETE CASCADE).
    deleted.conversations = (await client.query("DELETE FROM conversations WHERE site_id = $1 AND contact_email = $2", [siteId, normalized])).rowCount;
    deleted.notes = (await client.query("DELETE FROM contact_notes WHERE site_id = $1 AND contact_email = $2", [siteId, normalized])).rowCount;
    deleted.quotes = (await client.query("DELETE FROM quotes WHERE site_id = $1 AND contact_email = $2", [siteId, normalized])).rowCount;
    deleted.opportunities = (await client.query("DELETE FROM opportunities WHERE site_id = $1 AND contact_email = $2", [siteId, normalized])).rowCount;
    deleted.followup_runs = (await client.query("DELETE FROM followup_runs WHERE site_id = $1 AND email = $2", [siteId, normalized])).rowCount;
    deleted.reply_suggestions = (await client.query("DELETE FROM reply_suggestions WHERE site_id = $1 AND contact_email = $2", [siteId, normalized])).rowCount;
    deleted.payment_links = (await client.query("DELETE FROM payment_links WHERE site_id = $1 AND contact_email = $2", [siteId, normalized])).rowCount;
    deleted.contact = (await client.query("DELETE FROM contacts WHERE site_id = $1 AND email = $2", [siteId, normalized])).rowCount;
    deleted.newsletter_subscriber = (await client.query("DELETE FROM newsletter_subscribers WHERE site_id = $1 AND email = $2", [siteId, normalized])).rowCount;
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return deleted;
}
