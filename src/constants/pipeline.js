// Stadi fissi del modulo pipeline vendite. contacts.status resta testo
// libero a livello di schema (usato anche fuori dal modulo, come stato CRM
// generico) — qui è solo il vocabolario che la UI/kanban del modulo
// conosce e propone. Un contatto con uno status che non è una di queste
// chiavi (vuoto, o testo libero pre-esistente) compare nella colonna
// "Da assegnare".
export const PIPELINE_STAGES = [
  { key: "lead", label: "Lead" },
  { key: "contattato", label: "Contattato" },
  { key: "chiamata_fissata", label: "Chiamata fissata" },
  { key: "proposta_inviata", label: "Proposta inviata" },
  { key: "vinto", label: "Vinto" },
  { key: "perso", label: "Perso" },
];

export const PIPELINE_STAGE_KEYS = new Set(PIPELINE_STAGES.map(s => s.key));
