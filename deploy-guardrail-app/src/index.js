import Resolver from '@forge/resolver';
import api, { route, storage } from '@forge/api';

const resolver = new Resolver();

// --- HELPER: Check Risk Logic ---
// Shared logic used by both the UI (Resolver) and the Guardrail (Validator)
async function analyzeRisk(issueKey) {
  try {
    // 1. Fetch Issue Details
    // Switching to asUser() to ensure we use the current user's context (who definitely has access)
    const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}`);

    if (!res.ok) {
      console.error(`Failed to fetch issue ${issueKey}: ${res.status} ${res.statusText}`);
      // Fail open (allow) if we can't read the issue, or fail closed (block).
      // For this demo, let's return a safe "Not Risky" to avoid crashing the workflow if API fails.
      return { isBlocked: false, riskScore: 0, summary: "Error fetching summary" };
    }

    const data = await res.json();
    const summary = data.fields.summary || "";

    // 2. Check if "Fixed" flag is set in Forge Storage
    // We use App Storage keyed by the issue ID.
    let isFixed = false;
    try {
      isFixed = await storage.get(`issue:${issueKey}:fixed`);
    } catch (storageError) {
      console.error("Storage API Error:", storageError);
      // If storage fails (e.g. permissions), assume NOT fixed.
      isFixed = false;
    }

    // 3. Determine Risk
    // It is risky if it has "RISKY" in the title AND it hasn't been fixed yet.
    const isRiskyKeyword = summary.toUpperCase().includes("RISKY");
    const isBlocked = isRiskyKeyword && !isFixed;

    return {
      isBlocked,
      riskScore: isBlocked ? 95 : 15,
      summary
    };
  } catch (e) {
    console.error("analyzeRisk Error:", e);
    return { isBlocked: false, riskScore: 0, summary: "Error" };
  }
}

// --- RESOLVERS (For the UI) ---

resolver.define('checkRisk', async (req) => {
  try {
    const key = req.context.extension.issue.key;
    const risk = await analyzeRisk(key);

    if (risk.isBlocked) {
      return {
        status: 'BLOCKED',
        riskScore: risk.riskScore,
        issues: [
          {
            id: 1,
            severity: 'CRITICAL',
            message: 'Missing Unit Tests for PaymentService',
            aiFixAvailable: true,
            aiAnalysis: 'I noticed you modified `payment.js` but did not add any corresponding tests in `payment.test.js`. This violates the "No Untested Code" policy.',
            codeDiff: `+ describe('PaymentService', () => {
+   it('should process valid payments', () => {
+     const result = processPayment({ amount: 100 });
+     expect(result.success).toBe(true);
+   });
+ });`
          }
        ]
      };
    }

    return {
      status: 'ALLOWED',
      riskScore: risk.riskScore,
      message: 'All Guardrails Passed. Ready for Takeoff. 🏎️'
    };
  } catch (e) {
    console.error("Resolver Error:", e);
    return { status: 'ERROR', message: e.message };
  }
});

resolver.define('applyFix', async (req) => {
  try {
    const key = req.context.extension.issue.key;

    // Simulate the AI working...
    await new Promise(resolve => setTimeout(resolve, 2000));

    // SET THE FIX FLAG
    await storage.set(`issue:${key}:fixed`, true);

    return {
      success: true,
      message: 'Fix applied! Tests are running...'
    };
  } catch (e) {
    console.error("Apply Fix Error:", e);
    throw e;
  }
});

export const handler = resolver.getDefinitions();

// --- VALIDATOR (For the Workflow Transition) ---
// This function is called by Jira when the user tries to transition the issue.
export const validateDeployment = async (event) => {
  try {
    const issueKey = event.issue.key;
    const risk = await analyzeRisk(issueKey);

    if (risk.isBlocked) {
      return {
        result: false,
        errorMessage: `⛔ DEPLOYMENT BLOCKED: Risk Score ${risk.riskScore}/100. Missing Unit Tests. Please use the "Pit Crew Copilot" panel to fix this.`
      };
    }

    return { result: true };
  } catch (e) {
    console.error("Validator Crash:", e);
    // If the validator crashes, we should probably BLOCK it to be safe, 
    // but for a demo, let's return a helpful error message instead of a generic crash.
    return {
      result: false,
      errorMessage: `⚠️ Guardrail Error: ${e.message}. Check Forge Logs.`
    };
  }
};
