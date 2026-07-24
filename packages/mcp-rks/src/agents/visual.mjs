import { z } from 'zod';
import { spawn } from 'child_process';
import { createConnection } from 'net';
import { chromium } from 'playwright';
import Anthropic from '@anthropic-ai/sdk';
import { readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir } from 'fs/promises';
import { loadAgentConfig } from './config.mjs';
import { assertAnthropicCredential } from '../llm/credential-preflight.mjs';

/**
 * Detects if a port is available (not occupied)
 * @param {number} port - Port number to check
 * @returns {Promise<boolean>} True if port is available, false if occupied
 */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const socket = createConnection(port, 'localhost');
    socket.once('connect', () => {
      socket.destroy();
      resolve(false); // Port is occupied
    });
    socket.once('error', () => {
      resolve(true); // Port is available
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(true);
    });
  });
}

/**
 * Visual Agent Input Schema
 * Validates projectId (required) and request (required string)
 */
export const VisualInputSchema = z.object({
  projectId: z.string().describe('Project identifier'),
  request: z.string().describe('Visual QA request (e.g., "Check homepage for broken images")'),
});

/**
 * Check Plan Schema
 * Validates a single check plan entry with URL, viewport, and criteria
 */
export const CheckPlanSchema = z.object({
  url: z.string().describe('URL to check'),
  viewport: z.string().optional().describe('Viewport size (e.g., "1920x1080")'),
  criteria: z.string().describe('Pass/fail criteria for this check'),
});

/**
 * Visual Agent Output Schema
 * Validates ok (boolean), summary (string), and checks array with details
 */
export const VisualOutputSchema = z.object({
  ok: z.boolean().describe('Whether the visual QA check succeeded'),
  summary: z.string().describe('Summary of visual QA findings'),
  checks: z.array(
    z.object({
      url: z.string().describe('URL that was checked'),
      viewport: z.string().optional().describe('Viewport size (e.g., "1920x1080")'),
      criteria: z.string().describe('What was being checked'),
      passed: z.boolean().describe('Whether the check passed'),
      observation: z.string().describe('Details of what was observed'),
    })
  ).default([]).describe('Array of visual checks performed'),
});

// Module-level reference to spawned dev server process
let devServerProcess = null;

/**
 * Start the dev server if not already running.
 * Checks if the configured port is occupied; if available, spawns the server process.
 * Waits for readyPattern to appear in stdout before resolving.
 * @param {object} devServerConfig - Config object with command, port, readyPattern, startupTimeout
 * @returns {Promise<object>} { alreadyRunning: boolean }
 */
export async function startDevServer(devServerConfig) {
  const { command, port, readyPattern, startupTimeout = 30000 } = devServerConfig;

  // Check if port is already in use
  const available = await isPortAvailable(port);
  if (!available) {
    return { alreadyRunning: true };
  }

  // Port is available; spawn the dev server
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(' ');
    devServerProcess = spawn(cmd, args, {
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: true,
    });

    let stdout = '';
    let timeoutHandle;

    devServerProcess.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (readyPattern && stdout.includes(readyPattern)) {
        clearTimeout(timeoutHandle);
        resolve({ alreadyRunning: false });
      }
    });

    devServerProcess.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to start dev server: ${err.message}`));
    });

    devServerProcess.on('exit', (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0 && stdout === '') {
        reject(new Error(`Dev server exited with code ${code}`));
      }
    });

    timeoutHandle = setTimeout(() => {
      devServerProcess.kill();
      devServerProcess = null;
      reject(new Error(`Dev server startup timeout after ${startupTimeout}ms`));
    }, startupTimeout);
  });
}

/**
 * Stop the dev server process if running.
 * Kills the spawned process by PID and clears the reference.
 * @returns {Promise<void>}
 */
export async function stopDevServer() {
  return new Promise((resolve, reject) => {
    if (!devServerProcess) {
      resolve();
      return;
    }

    devServerProcess.on('exit', () => {
      devServerProcess = null;
      resolve();
    });

    devServerProcess.on('error', (err) => {
      devServerProcess = null;
      reject(new Error(`Failed to stop dev server: ${err.message}`));
    });

    devServerProcess.kill();

    // Force kill after 5 seconds if graceful shutdown doesn't work
    setTimeout(() => {
      if (devServerProcess) {
        devServerProcess.kill('SIGKILL');
        devServerProcess = null;
      }
    }, 5000);
  });
}

/**
 * Capture screenshots for a check plan using Playwright.
 * @param {Array} checkPlan - Array of check plan entries with url, viewport, criteria
 * @param {object} config - Config object with optional launchOptions
 * @returns {Promise<Array>} Array of { url, viewport, screenshotPath, capturedAt }
 * @throws {Error} On browser launch failure or critical capture errors
 */
export async function captureScreenshots(checkPlan, config = {}) {
  const screenshotDir = join(tmpdir(), `rks-visual-qa-${Date.now()}`);
  await mkdir(screenshotDir, { recursive: true });

  let browser = null;
  const results = [];

  try {
    browser = await chromium.launch({ headless: true, ...config.launchOptions });

    for (const check of checkPlan) {
      const { url, viewport, criteria } = check;

      try {
        const context = await browser.newContext({
          viewport: parseViewport(viewport || '1920x1080'),
        });
        const page = await context.newPage();

        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });

          const filename = `${url.replace(/[^a-z0-9]/gi, '-')}-${Date.now()}.png`;
          const screenshotPath = join(screenshotDir, filename);
          await page.screenshot({ path: screenshotPath, fullPage: true });

          results.push({
            url,
            viewport: viewport || '1920x1080',
            screenshotPath,
            capturedAt: new Date().toISOString(),
          });
        } catch (err) {
          results.push({
            url,
            viewport: viewport || '1920x1080',
            screenshotPath: null,
            capturedAt: new Date().toISOString(),
            error: err.message,
          });
        } finally {
          await page.close();
          await context.close();
        }
      } catch (err) {
        results.push({
          url,
          viewport: viewport || '1920x1080',
          screenshotPath: null,
          capturedAt: new Date().toISOString(),
          error: err.message,
        });
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return results;
}

/**
 * Parse a viewport string like "1920x1080" to { width, height } object.
 * @param {string} viewportStr - Viewport string (e.g., "1920x1080")
 * @returns {object} { width: number, height: number }
 */
function parseViewport(viewportStr) {
  const [width, height] = viewportStr.split('x').map(Number);
  return { width: width || 1920, height: height || 1080 };
}

/**
 * Generate a structured check plan from story visualChecks.
 * @param {Array} visualChecks - Array of visual check objects from story
 * @returns {Array} Structured check plan with URL, viewport, and criteria for each check
 * @throws {Error} If visualChecks is not an array or contains invalid entries
 */
export function generateCheckPlan(visualChecks) {
  if (!Array.isArray(visualChecks)) {
    throw new Error('visualChecks must be an array');
  }

  return visualChecks.map((check) => {
    const validated = CheckPlanSchema.parse(check);
    return {
      url: validated.url,
      viewport: validated.viewport || '1920x1080',
      criteria: validated.criteria,
    };
  });
}

/**
 * Assess a captured screenshot against a check plan entry using Anthropic vision API.
 * @param {string} screenshotPath - Path to screenshot file on disk
 * @param {object} checkPlanEntry - Check plan entry { url, viewport, criteria }
 * @returns {Promise<object>} Assessment result { passed: boolean, observation: string }
 */
export async function assessScreenshot(screenshotPath, checkPlanEntry) {
  if (!screenshotPath) {
    return {
      passed: false,
      observation: 'No screenshot captured - check failed to capture image',
    };
  }

  const { url, criteria } = checkPlanEntry;

  try {
    const imageBuffer = await readFile(screenshotPath);
    const base64Image = imageBuffer.toString('base64');

    // Invoke-time credential gate (shared guard) — clear, value-free error before the SDK is
    // constructed on a keyless boot; surfaced by the enclosing catch as a graceful observation.
    assertAnthropicCredential();
    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Analyze this screenshot of ${url} against the following visual QA criteria: "${criteria}"

Provide a concise assessment:
1. Does the screenshot meet the criteria? (yes/no)
2. What specific visual observations support this assessment?
3. Any issues found (broken images, layout problems, text readability, spacing, responsiveness, etc.)?

Format your response as JSON: { "passed": boolean, "observation": "string with specific findings" }`,
            },
          ],
        },
      ],
    });

    const responseText = message.content[0].type === 'text' ? message.content[0].text : '';

    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          passed: Boolean(parsed.passed),
          observation: String(parsed.observation || responseText),
        };
      }
    } catch (parseErr) {
      // Fallback if JSON parsing fails
    }

    return {
      passed: responseText.toLowerCase().includes('pass') || responseText.toLowerCase().includes('meets'),
      observation: responseText,
    };
  } catch (err) {
    return {
      passed: false,
      observation: `Vision API assessment failed: ${err.message}`,
    };
  }
}

/**
 * Create a visual agent config.
 * @param {object} input - Agent input { projectId, request, projectRoot }
 * @returns {object} Agent config for runner.mjs
 */
export function createVisualAgent(input) {
  const { projectId, request, projectRoot } = input;

  // Load base agent config
  const config = loadAgentConfig('visual');

  return {
    ...config,
    name: 'visual',
    userMessage: `Project: ${projectId}\nRequest: ${request}`,
    projectRoot,
  };
}

/**
 * Main execution flow for visual QA agent.
 * Wires config loading -> dev server -> check plan -> screenshot capture -> assessment -> cleanup.
 * @param {object} input - Agent input { projectId, request, visualChecks, devServerConfig, projectRoot }
 * @returns {Promise<object>} VisualOutputSchema result object
 */
export async function runVisualAgent(input) {
  const { projectId, request, visualChecks, devServerConfig, projectRoot } = input;

  let startResult = null;
  const allChecks = [];

  try {
    // Start dev server
    if (devServerConfig) {
      startResult = await startDevServer(devServerConfig);
    }

    // Generate check plan from visual checks
    let checkPlan = [];
    if (visualChecks && Array.isArray(visualChecks)) {
      try {
        checkPlan = generateCheckPlan(visualChecks);
      } catch (planErr) {
        return {
          ok: false,
          summary: `Failed to generate check plan: ${planErr.message}`,
          checks: [],
        };
      }
    }

    // Capture screenshots
    let captureResults = [];
    if (checkPlan.length > 0) {
      try {
        captureResults = await captureScreenshots(checkPlan, { launchOptions: { args: ['--no-sandbox'] } });
      } catch (captureErr) {
        return {
          ok: false,
          summary: `Screenshot capture failed: ${captureErr.message}`,
          checks: [],
        };
      }
    }

    // Assess each screenshot
    for (let i = 0; i < checkPlan.length; i++) {
      const checkPlanEntry = checkPlan[i];
      const captureResult = captureResults[i];

      let assessment = { passed: false, observation: 'No screenshot available' };

      if (captureResult && captureResult.screenshotPath) {
        try {
          assessment = await assessScreenshot(captureResult.screenshotPath, checkPlanEntry);
        } catch (assessErr) {
          assessment = {
            passed: false,
            observation: `Assessment failed: ${assessErr.message}`,
          };
        }
      } else if (captureResult && captureResult.error) {
        assessment = {
          passed: false,
          observation: `Capture failed: ${captureResult.error}`,
        };
      }

      allChecks.push({
        url: checkPlanEntry.url,
        viewport: checkPlanEntry.viewport || '1920x1080',
        criteria: checkPlanEntry.criteria,
        passed: assessment.passed,
        observation: assessment.observation,
      });
    }

    // Determine overall success
    const allPassed = allChecks.length > 0 && allChecks.every(check => check.passed);
    const summary = allPassed
      ? `Visual QA passed: ${allChecks.length} check(s) completed successfully`
      : `Visual QA completed with ${allChecks.filter(c => c.passed).length}/${allChecks.length} checks passing`;

    return {
      ok: allPassed,
      summary,
      checks: allChecks,
    };
  } finally {
    // Cleanup: stop dev server if we started it
    if (startResult && !startResult.alreadyRunning && devServerConfig) {
      try {
        await stopDevServer();
      } catch (stopErr) {
        console.error('Error stopping dev server:', stopErr);
      }
    }
  }
}
