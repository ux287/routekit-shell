import { z } from "zod";

const GetElementInfoArgsSchema = z.object({
  url: z.string().url(),
  selector: z.string(),
});

export async function getElementInfoTool(browser, args) {
  const { url, selector } = GetElementInfoArgsSchema.parse(args);

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(url);
    
    const result = await page.evaluate(
      (selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          return { found: false, selector };
        }

        const rect = element.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(element);
        
        // Get key computed styles for typography and layout
        const keyStyles = {
          fontFamily: computedStyle.getPropertyValue("font-family"),
          fontSize: computedStyle.getPropertyValue("font-size"),
          fontWeight: computedStyle.getPropertyValue("font-weight"),
          color: computedStyle.getPropertyValue("color"),
          backgroundColor: computedStyle.getPropertyValue("background-color"),
          display: computedStyle.getPropertyValue("display"),
          position: computedStyle.getPropertyValue("position"),
          margin: computedStyle.getPropertyValue("margin"),
          padding: computedStyle.getPropertyValue("padding"),
          width: computedStyle.getPropertyValue("width"),
          height: computedStyle.getPropertyValue("height")
        };

        return {
          found: true,
          selector,
          tagName: element.tagName,
          id: element.id || "",
          classList: Array.from(element.classList),
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          computedStyles: keyStyles
        };
      },
      selector
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