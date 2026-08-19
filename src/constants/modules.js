// Registro statico dei moduli opzionali attivabili per sito (site_modules).
// Aggiungere un modulo qui basta a farlo comparire nel toggle di
// admin/sites/:id/edit — le route/vista effettive restano un normale
// router Express, gated da requireModule (vedi middleware/modules.js).
export const MODULES = {
  sales_pipeline: {
    name: "Pipeline vendite",
    description: "Stadi fissi sui contatti (lead → contattato → proposta → vinto/perso), vista kanban, valore stimato affare.",
  },
  call_scheduling: {
    name: "Chiamate",
    description: "Programmazione/log chiamate dalla scheda contatto, pagina pubblica di autoprenotazione con slot da disponibilità settimanale.",
  },
};

export const MODULE_KEYS = Object.keys(MODULES);
