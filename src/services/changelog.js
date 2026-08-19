export function buildChangelogMessage(entry) {
  const { entity_type, action, new_data, old_data, user_name } = entry;
  const who = user_name || "Agente AI";
  const nd = new_data || {};
  const od = old_data || {};

  switch (`${entity_type}:${action}`) {
    case "page:create": return `${who} ha creato la pagina "${nd.url_path || nd.title || "?"}"`;
    case "page:update":
      if (nd.section) return `${who} ha aggiornato la sezione "${nd.section}" nella pagina "${od.url_path || "?"}"`;
      return `${who} ha modificato la pagina "${nd.url_path || od.url_path || "?"}"`;
    case "page:delete": return `${who} ha eliminato la pagina "${od.url_path || "?"}"`;
    case "page:publish": return `${who} ha pubblicato la pagina "${nd.url_path || "?"}"`;
    case "page:restore": return `${who} ha ripristinato la pagina "${nd.url_path || "?"}" a una versione precedente`;
    case "snippet:create": return `${who} ha creato lo snippet "${nd.name || "?"}"`;
    case "snippet:update": return `${who} ha modificato lo snippet "${nd.name || od.name || "?"}"`;
    case "snippet:delete": return `${who} ha eliminato lo snippet "${od.name || "?"}"`;
    default: return `${who} ha eseguito '${action}' su ${entity_type}`;
  }
}
