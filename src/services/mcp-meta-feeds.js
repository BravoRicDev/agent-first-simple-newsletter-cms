import { z } from "zod";
const flag = (d) => z.union([z.string(), z.number()]).optional().describe(d);
export const META = {
  "GET /api/agent/sites/:siteId/feeds": {
    name: "feeds_list",
    description: { en: "Lists the RSS/Atom feed URLs of the site and whether feeds are enabled (enable with blog_settings_update feed_enabled=\"1\").", it: "Elenca gli URL dei feed RSS/Atom del sito e se i feed sono attivi (si attivano con blog_settings_update feed_enabled=\"1\")." },
    inputSchema: { site_id: z.number() },
  },
  "PUT /api/agent/sites/:siteId/blog-settings": {
    name: "blog_settings_update",
    description: {
      en: "Updates blog settings for a site (blog_articles_per_page, blog_card_template, blog_article_embed_template, blog_index_title, blog_index_intro_html, homepage_custom_css, homepage_custom_js, feed_enabled, feed_item_limit, feed_full_content, search_enabled, search_language, editorial_workflow_enabled, images_srcset_mode). Flags are the strings \"1\"/\"0\". Unknown keys are ignored; send only the fields to change.",
      it: "Aggiorna le impostazioni del blog di un sito (blog_articles_per_page, blog_card_template, blog_article_embed_template, blog_index_title, blog_index_intro_html, homepage_custom_css, homepage_custom_js, feed_enabled, feed_item_limit, feed_full_content, search_enabled, search_language, editorial_workflow_enabled, images_srcset_mode). I flag sono le stringhe \"1\"/\"0\". Le chiavi sconosciute sono ignorate; invia solo i campi da cambiare.",
    },
    inputSchema: {
      site_id: z.number(),
      blog_articles_per_page: z.union([z.string(), z.number()]).optional(), blog_card_template: z.string().optional(), blog_article_embed_template: z.string().optional(),
      blog_index_title: z.string().optional(), blog_index_intro_html: z.string().optional(), homepage_custom_css: z.string().optional(), homepage_custom_js: z.string().optional(),
      feed_enabled: flag('"1" enables RSS/Atom feeds, "0" disables'),
      feed_item_limit: flag("1..100, default 20"),
      feed_full_content: flag('"1" puts the full HTML in the feed items'),
      search_enabled: flag('"1" enables the public search endpoint and the {{search}} widget'),
      search_language: z.enum(["italian", "english", "simple"]).optional(),
      editorial_workflow_enabled: flag('"1" turns the editorial workflow ON (only admin/superadmin or users with pages:["publish"] can change it)'),
      images_srcset_mode: z.enum(["0", "srcset", "picture"]).optional(),
    },
  },
};
