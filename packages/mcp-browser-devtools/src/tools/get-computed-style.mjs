import { z } from "zod";

const GetComputedStyleArgsSchema = z.object({
  url: z.string().url(),
  selector: z.string(),
  properties: z.array(z.string()).optional(),
});

export async function getComputedStyleTool(browser, args) {
  const { url, selector, properties } = GetComputedStyleArgsSchema.parse(args);

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url);
    
    const result = await page.evaluate(
      ({ selector, properties }) => {
        const element = document.querySelector(selector);
        if (!element) {
          return { found: false, selector };
        }

        const computedStyle = window.getComputedStyle(element);
        const styles = {};

        if (properties && properties.length > 0) {
          // Return only requested properties
          for (const prop of properties) {
            const kebabProp = prop.replace(/([A-Z])/g, "-$1").toLowerCase();
            styles[prop] = computedStyle.getPropertyValue(kebabProp);
          }
        } else {
          // Return common style properties
          const commonProps = [
            "font-family",
            "font-size",
            "font-weight",
            "color",
            "background-color",
            "display",
            "position",
            "margin",
            "padding",
            "width",
            "height"
          ];
          for (const prop of commonProps) {
            const camelProp = prop.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
            styles[camelProp] = computedStyle.getPropertyValue(prop);
          }
        }

        return {
          found: true,
          selector,
          styles
        };
      },
      { selector, properties }
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } finally {
    await context.close();
  }
}