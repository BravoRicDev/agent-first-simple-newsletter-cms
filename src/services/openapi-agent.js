import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const camelToSnake = (s) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const pathParamNames = (p) => [...p.matchAll(/:([a-zA-Z0-9_]+)/g)].map((m) => m[1]);
const toOpenApiPath = (p) => p.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");
const firstSentence = (s) => { const t = String(s || "").trim(); const m = t.match(/^(.{1,200}?[.!?])(\s|$)/); return (m ? m[1] : t).slice(0, 200); };

function stripSchemaKey(js) { const { $schema, ...rest } = js; return rest; }

// tools: output di discoverTools(lang); helpers: { AREAS, categoryOf, areaOfCategory } da mcp-tree.js
export function buildOpenApiDocument(tools, { lang = "en", baseUrl = "", area = null, version = "1.0", helpers }) {
  const { AREAS, categoryOf, areaOfCategory } = helpers;
  const paths = {};
  const usedAreas = new Set();
  for (const tool of tools) {
    const category = categoryOf(tool.path);
    const areaId = areaOfCategory(category);
    if (area && areaId !== area) continue;
    usedAreas.add(areaId);
    const js = stripSchemaKey(zodToJsonSchema(z.object(tool.inputSchema), { target: "jsonSchema7", $refStrategy: "none" }));
    const props = js.properties || {};
    const required = new Set(js.required || []);
    const generic = !tool.enriched; // schema = { ...path params, extra }
    const camelNames = pathParamNames(tool.path);
    const consumed = new Set(camelNames.map(camelToSnake));
    const parameters = camelNames.map((camel) => {
      const snake = camelToSnake(camel);
      const { description, ...schema } = props[snake] || { type: "string" };
      return { name: camel, in: "path", required: true, schema, ...(description ? { description } : {}), "x-mcp-argument": snake };
    });
    const rest = Object.entries(props).filter(([k]) => !consumed.has(k) && !(generic && k === "extra"));
    const op = {
      operationId: tool.name,
      summary: firstSentence(tool.description),
      description: tool.description,
      tags: [areaId],
      "x-mcp-tool": tool.name,
      "x-mcp-category": category,
      "x-requires-write-scope": tool.method !== "GET",
      security: [{ bearerAuth: [] }],
      parameters,
      responses: {
        "200": { description: "Success (JSON body; shape is endpoint specific)", content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        "400": { $ref: "#/components/responses/Error" },
        "401": { $ref: "#/components/responses/Error" },
        "403": { $ref: "#/components/responses/Error" },
        "404": { $ref: "#/components/responses/Error" },
      },
    };
    if (BODY_METHODS.has(tool.method)) {
      if (tool.multipart) {
        op.requestBody = { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] } } } };
      } else {
        const bodyProps = Object.fromEntries(rest);
        const bodyRequired = rest.map(([k]) => k).filter((k) => required.has(k));
        op.requestBody = { required: bodyRequired.length > 0, content: { "application/json": { schema: { type: "object", properties: bodyProps, ...(bodyRequired.length ? { required: bodyRequired } : {}), ...(generic ? { additionalProperties: true } : {}) } } } };
      }
    } else {
      for (const [k, prop] of rest) {
        const { description, ...schema } = prop;
        const structured = schema.type === "object" || schema.type === "array";
        op.parameters.push({ name: k, in: "query", required: required.has(k), ...(description ? { description } : {}),
          ...(structured ? { content: { "application/json": { schema } } } : { schema }) });
      }
    }
    const p = toOpenApiPath(tool.path);
    (paths[p] ||= {})[tool.method.toLowerCase()] = op;
  }
  const label = (a) => (lang === "it" ? a.it : a.en);
  const tags = AREAS.filter((a) => usedAreas.has(a.id)).map((a) => ({ name: a.id, description: label(a) }));
  if (usedAreas.has("other")) tags.push({ name: "other", description: "Other" });
  return {
    openapi: "3.1.0",
    info: { title: "CMS Agent API", version, description: "Generated from the MCP tool catalog (same definitions). Auth: Authorization: Bearer <agtok_ API token or session JWT>. Write operations need a token with the write scope." },
    ...(baseUrl ? { servers: [{ url: baseUrl }] } : {}),
    tags,
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT or agtok_ API token" } },
      responses: { Error: { description: "Error", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" }, code: { type: "string" } }, additionalProperties: true } } } } },
    },
  };
}
