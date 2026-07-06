import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { chromium } from "playwright";
import { getComputedStyleTool } from "../../packages/mcp-browser-devtools/src/tools/get-computed-style.mjs";
import { getElementInfoTool } from "../../packages/mcp-browser-devtools/src/tools/get-element-info.mjs";

describe.skip("Browser DevTools MCP — requires Playwright (plugin candidate)", () => {
  let browser;
  let mockServer;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    
    // Create a simple test page
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            .test-element {
              font-family: "Arial", sans-serif;
              font-size: 24px;
              font-weight: bold;
              color: rgb(255, 0, 0);
              padding: 10px;
              margin: 20px;
            }
          </style>
        </head>
        <body>
          <h1 class="test-element" id="test-heading">Test Heading</h1>
        </body>
      </html>
    `);
    
    // Start a simple HTTP server for testing
    mockServer = await page.context().addInitScript(() => {
      // Mock server setup would go here in a real implementation
    });
    
    await context.close();
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
  });

  describe("get_computed_style", () => {
    it("should return computed styles for existing element", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              .hero-headline {
                font-family: "Source Sans 3", sans-serif;
                font-size: 48px;
                color: rgb(51, 51, 51);
              }
            </style>
          </head>
          <body>
            <h1 class="hero-headline">Test</h1>
          </body>
        </html>
      `);

      const args = {
        url: page.url(),
        selector: ".hero-headline",
        properties: ["font-family", "font-size", "color"]
      };

      const result = await getComputedStyleTool(browser, args);
      const data = JSON.parse(result.content[0].text);

      expect(data.found).toBe(true);
      expect(data.selector).toBe(".hero-headline");
      expect(data.styles["font-family"]).toContain("Source Sans 3");
      expect(data.styles["font-size"]).toBe("48px");
      expect(data.styles["color"]).toBe("rgb(51, 51, 51)");
      
      await context.close();
    });

    it("should return only requested properties when specified", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      
      await page.setContent(`
        <h1 class="test">Test</h1>
      `);

      const args = {
        url: page.url(),
        selector: ".test",
        properties: ["font-size"]
      };

      const result = await getComputedStyleTool(browser, args);
      const data = JSON.parse(result.content[0].text);

      expect(data.found).toBe(true);
      expect(Object.keys(data.styles)).toEqual(["font-size"]);
      
      await context.close();
    });

    it("should handle element not found", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      
      await page.setContent(`<h1>Test</h1>`);

      const args = {
        url: page.url(),
        selector: ".non-existent"
      };

      const result = await getComputedStyleTool(browser, args);
      const data = JSON.parse(result.content[0].text);

      expect(data.found).toBe(false);
      expect(data.selector).toBe(".non-existent");
      
      await context.close();
    });
  });

  describe("get_element_info", () => {
    it("should return comprehensive element information", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      
      await page.setContent(`
        <!DOCTYPE html>
        <html>
          <head>
            <style>
              .info-test {
                font-family: "Arial", sans-serif;
                font-size: 32px;
                font-weight: 700;
                color: rgb(0, 0, 255);
                padding: 15px;
                margin: 25px;
              }
            </style>
          </head>
          <body>
            <div class="info-test additional-class" id="test-div">Test Content</div>
          </body>
        </html>
      `);

      const args = {
        url: page.url(),
        selector: ".info-test"
      };

      const result = await getElementInfoTool(browser, args);
      const data = JSON.parse(result.content[0].text);

      expect(data.found).toBe(true);
      expect(data.selector).toBe(".info-test");
      expect(data.tagName).toBe("DIV");
      expect(data.id).toBe("test-div");
      expect(data.classList).toEqual(["info-test", "additional-class"]);
      expect(data.boundingBox).toHaveProperty("x");
      expect(data.boundingBox).toHaveProperty("y");
      expect(data.boundingBox).toHaveProperty("width");
      expect(data.boundingBox).toHaveProperty("height");
      expect(data.computedStyles.fontFamily).toContain("Arial");
      expect(data.computedStyles.fontSize).toBe("32px");
      expect(data.computedStyles.fontWeight).toBe("700");
      
      await context.close();
    });

    it("should handle element not found", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      
      await page.setContent(`<div>Test</div>`);

      const args = {
        url: page.url(),
        selector: ".missing-element"
      };

      const result = await getElementInfoTool(browser, args);
      const data = JSON.parse(result.content[0].text);

      expect(data.found).toBe(false);
      expect(data.selector).toBe(".missing-element");
      
      await context.close();
    });
  });

  describe("Error handling", () => {
    it("should handle invalid URL gracefully", async () => {
      const args = {
        url: "http://invalid-url-that-does-not-exist.local",
        selector: ".test"
      };

      const result = await getComputedStyleTool(browser, args);
      
      // Should return error in content
      expect(result.content[0].text).toContain("Error:");
    });
  });
});