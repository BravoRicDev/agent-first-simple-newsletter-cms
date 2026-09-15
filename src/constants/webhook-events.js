// ─────────────────────────────────────────────────────────────────────────
// Eventi disponibili per webhook OUT e workflow: source of truth condivisa
// tra UI admin, agent API e MCP. Ogni voce ha etichetta e descrizione in IT.
// `group` aiuta la UI a raggruppare.
// ─────────────────────────────────────────────────────────────────────────

export const WEBHOOK_EVENTS = [
  { value: "contact_created", label: "Contatto creato", group: "Contatti", description: "Un nuovo contatto è stato creato" },
  { value: "contact_updated", label: "Contatto aggiornato", group: "Contatti", description: "I dati di un contatto sono stati aggiornati" },
  { value: "contact_deleted", label: "Contatto eliminato", group: "Contatti", description: "Un contatto è stato eliminato" },
  { value: "tag_added", label: "Tag aggiunto", group: "Contatti", description: "Un tag è stato aggiunto a un contatto" },
  { value: "tag_removed", label: "Tag rimosso", group: "Contatti", description: "Un tag è stato rimosso da un contatto" },
  { value: "stage_changed", label: "Stadio pipeline cambiato", group: "Pipeline", description: "Il contatto ha cambiato stadio nella pipeline" },
  { value: "custom_field_updated", label: "Campo custom aggiornato", group: "Contatti", description: "Un campo personalizzato del contatto è stato aggiornato" },

  { value: "opportunity_created", label: "Opportunità creata", group: "Pipeline", description: "Una nuova opportunità è stata creata" },
  { value: "opportunity_updated", label: "Opportunità aggiornata", group: "Pipeline", description: "Un'opportunità è stata aggiornata" },
  { value: "opportunity_stage_changed", label: "Stadio opportunità cambiato", group: "Pipeline", description: "Un'opportunità ha cambiato stadio" },
  { value: "opportunity_status_changed", label: "Stato opportunità cambiato", group: "Pipeline", description: "Lo stato di un'opportunità è cambiato" },
  { value: "opportunity_deleted", label: "Opportunità eliminata", group: "Pipeline", description: "Un'opportunità è stata eliminata" },
  { value: "quote_sent", label: "Preventivo inviato", group: "Pipeline", description: "Un preventivo è stato inviato" },
  { value: "quote_viewed", label: "Preventivo visto", group: "Pipeline", description: "Un preventivo è stato visualizzato" },
  { value: "quote_signed", label: "Preventivo firmato", group: "Pipeline", description: "Un preventivo è stato firmato" },

  { value: "form_submitted", label: "Form inviato", group: "Form & Quiz", description: "Un form è stato inviato" },
  { value: "quiz_completed", label: "Quiz completato", group: "Form & Quiz", description: "Un quiz è stato completato" },
  { value: "conversation_message", label: "Messaggio conversazione", group: "Messaggi", description: "Un nuovo messaggio in una conversazione" },
  { value: "conversation_status_changed", label: "Stato conversazione cambiato", group: "Messaggi", description: "Lo stato di una conversazione è cambiato" },
  { value: "note_added", label: "Nota aggiunta", group: "Contatti", description: "Una nota è stata aggiunta a un contatto" },

  { value: "email_opened", label: "Email aperta", group: "Email", description: "Un destinatario ha aperto un'email" },
  { value: "email_clicked", label: "Email cliccata", group: "Email", description: "Un destinatario ha cliccato un link in un'email" },
  { value: "call_booked", label: "Chiamata prenotata", group: "Chiamate", description: "Una chiamata è stata prenotata" },
  { value: "call_status_changed", label: "Stato chiamata cambiato", group: "Chiamate", description: "Lo stato di una chiamata è cambiato" },
  { value: "score_threshold", label: "Punteggio soglia superato", group: "Lead scoring", description: "Il punteggio del lead ha superato la soglia" },
  { value: "segment_entered", label: "Entrato in segmento", group: "Segmenti", description: "Il contatto è entrato in un segmento" },
  { value: "manual", label: "Manuale", group: "Altro", description: "Trigger manuale (test)" },
  { value: "webhook", label: "Webhook in ingresso", group: "Webhook", description: "Evento in ingresso da un webhook esterno" },
];

// Eventi trattenuti dai webhook OUT di default (nessun filtro = tutti quelli listati sopra).
export const FILTERABLE_FIELDS = [
  { key: "form_slug", label: "Slug form", dotPath: "payload.form_slug" },
  { key: "to_stage", label: "Stadio di destinazione", dotPath: "payload.to_stage" },
  { key: "tag", label: "Tag", dotPath: "payload.tag" },
  { key: "status", label: "Stato", dotPath: "payload.status" },
  { key: "contact.email", label: "Email contatto", dotPath: "payload.contact.email" },
  { key: "opportunity.stage", label: "Stadio opportunità", dotPath: "payload.opportunity.stage" },
];