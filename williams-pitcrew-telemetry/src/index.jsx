import api, { route } from '@forge/api';

/**
 * Configuration for the Williams Racing telemetry incident scenario.
 * For this first version, we intentionally keep things simple:
 * - We listen for all Jira issue-created events.
 * - We filter down to likely incidents (by type/priority/keywords).
 * - We analyze a set of mock commits that represent the "bad" Bitbucket changes.
 * - We post an F1-themed analysis comment back to Jira.
 * - We create a lightweight Confluence incident report page.
 */
const CONFIG = {
  INCIDENT_KEYWORDS: ['CRITICAL', 'P1', 'URGENT', 'DOWN', 'OUTAGE'],
  CONFLUENCE_SPACE_KEY: 'INCIDENTS',
};

/**
 * Entry point for the product trigger.
 * This runs automatically whenever a Jira issue is created.
 */
export async function run(event, context) {
  console.log('🏎️ PitCrew trigger fired', JSON.stringify(event));

  try {
    const issueKey = event.issue.key;

    // 1. Fetch full issue details so we can inspect type, priority, and summary.
    const issueRes = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,priority,issuetype,description`
    );

    if (!issueRes.ok) {
      console.error(`PitCrew: failed to fetch issue ${issueKey}: ${issueRes.status}`);
      return;
    }

    const issue = await issueRes.json();
    const fields = issue.fields || {};
    const summary = fields.summary || '';
    const priorityName = (fields.priority && fields.priority.name) || '';
    const issueTypeName = (fields.issuetype && fields.issuetype.name) || '';
    const descriptionText = extractPlainTextDescription(fields.description);

    console.log(
      `PitCrew: inspecting ${issueKey} - type="${issueTypeName}", priority="${priorityName}", summary="${summary}"`
    );

    // 2. Determine whether this looks like a critical incident that PitCrew should respond to.
    const isIncident = issueTypeName.toLowerCase().includes('incident');
    const isHighPriority =
      priorityName.toLowerCase().includes('high') ||
      priorityName.toLowerCase().includes('critical') ||
      priorityName.toLowerCase().includes('highest');
    const hasCriticalKeyword = CONFIG.INCIDENT_KEYWORDS.some((keyword) =>
      summary.toUpperCase().includes(keyword)
    );

    if (!isIncident && !isHighPriority && !hasCriticalKeyword) {
      console.log(`PitCrew: ${issueKey} is not a critical incident. Standing by.`);
      return;
    }

    console.log(`🚨 PitCrew: CRITICAL INCIDENT DETECTED for ${issueKey}. Beginning analysis.`);

    // 3. For this first version, we use a fixed set of mock commits that represent the
    //    Williams telemetry service. Later, you can swap this for live Bitbucket data.
    const commits = getMockCommits();
    const analysis = await analyzeCommitsForIncident(commits, summary, descriptionText);

    // 4. Post the analysis back to the Jira ticket so the on-call engineer sees it immediately.
    await postPitCrewAnalysis(issueKey, analysis);

    // 5. Best-effort creation of a Confluence incident report.
    await createIncidentReport(issueKey, summary, analysis);

  } catch (error) {
    console.error('PitCrew: unhandled error in trigger:', error);
  }
}

// =============================================================================
// Helper: Safely extract plain text from the Jira description (ADF format)
// =============================================================================

function extractPlainTextDescription(description) {
  try {
    if (!description || !Array.isArray(description.content)) {
      return '';
    }

    const firstBlock = description.content[0];
    if (!firstBlock || !Array.isArray(firstBlock.content)) {
      return '';
    }

    const firstNode = firstBlock.content[0];
    if (!firstNode || typeof firstNode.text !== 'string') {
      return '';
    }

    return firstNode.text;
  } catch (e) {
    console.error('PitCrew: error extracting description text:', e);
    return '';
  }
}

// =============================================================================
// Mock Williams Telemetry Commits
// =============================================================================

/**
 * For the demo, we hard-code a few commits that simulate the "bad" tire
 * pressure change, plus some harmless noise commits. This lets you demo the
 * full PitCrew flow without wiring Bitbucket yet.
 */
function getMockCommits() {
  const now = new Date();

  return [
    {
      hash: 'a8j29f3',
      message: 'fix: Update tire pressure calculation threshold',
      author: 'Junior Developer',
      date: new Date(now.getTime() - 5 * 60000).toISOString(), // 5 minutes ago
      diff: `
diff --git a/pressure_calc.py b/pressure_calc.py
index 1234567..abcdefg 100644
--- a/pressure_calc.py
+++ b/pressure_calc.py
@@ -15,7 +15,7 @@ class TirePressureMonitor:
     def calculate_pressure_ratio(self, current_pressure, baseline):
         """Calculate the pressure ratio for telemetry display."""
-        safety_threshold = 30  # PSI - minimum safe pressure
+        safety_threshold = 0   # PSI - CHANGED FOR TESTING
         
         if baseline == 0:
             return 0
@@ -25,7 +25,7 @@ class TirePressureMonitor:
     def get_pressure_warning(self, pressure):
         """Returns warning level based on pressure reading."""
-        divisor = self.calibration_factor
+        divisor = 0  # BUG: This causes divide by zero!
         return pressure / divisor
`,
    },
    {
      hash: 'b7k38e2',
      message: 'chore: Update dependencies',
      author: 'DevOps Bot',
      date: new Date(now.getTime() - 15 * 60000).toISOString(),
      diff: '// Dependency updates only. No risky business here.',
    },
  ];
}

// =============================================================================
// Simple "AI" Analysis over the mock diffs
// =============================================================================

/**
 * Very lightweight heuristic that scans the mock diffs for obvious problems
 * (divide-by-zero, removal of safety thresholds, etc).
 *
 * In a production version, this is where you would call Rovo or another LLM
 * with the incident context + real Bitbucket diffs.
 */
async function analyzeCommitsForIncident(commits, incidentSummary, incidentDescription) {
  console.log('PitCrew: analyzing mock commits for potential root cause...');

  const analyzed = commits.map((commit) => {
    const issues = [];
    let confidence = 0;

    // Check for divide by zero patterns
    if (commit.diff.includes('divisor = 0') || commit.diff.includes('/ 0')) {
      issues.push({
        type: 'DIVIDE_BY_ZERO',
        description: 'Division by zero in tire pressure calculation will cause runtime 500s.',
        severity: 'CRITICAL',
      });
      confidence = 98;
    }

    // Check for safety threshold being set to 0
    if (commit.diff.includes('safety_threshold') && commit.diff.includes('= 0')) {
      issues.push({
        type: 'SAFETY_THRESHOLD_REMOVED',
        description: 'Safety threshold for minimum tire pressure was changed from 30 PSI to 0 PSI.',
        severity: 'CRITICAL',
      });
      confidence = Math.max(confidence, 95);
    }

    return {
      ...commit,
      issues,
      confidence,
      isSuspect: confidence >= 80,
    };
  });

  // Sort with the most suspicious commit first
  analyzed.sort((a, b) => b.confidence - a.confidence);
  const suspect = analyzed.find((c) => c.isSuspect) || null;

  return {
    commits: analyzed,
    suspect,
    totalCommitsAnalyzed: commits.length,
    analysisTime: new Date().toISOString(),
  };
}

// =============================================================================
// Jira Comment: PitCrew Analysis
// =============================================================================

async function postPitCrewAnalysis(issueKey, analysis) {
  let text;

  if (analysis.suspect) {
    const suspect = analysis.suspect;
    const issuesText = suspect.issues.map((i) => `• ${i.description}`).join('\n');

    text =
      `🏎️ PitCrew Alert: Root cause identified.\n\n` +
      `Suspect commit: ${suspect.hash} by ${suspect.author}\n` +
      `Confidence: ${suspect.confidence}%\n\n` +
      `Issues detected:\n${issuesText}\n\n` +
      `Recommendation: Revert commit ${suspect.hash} to restore telemetry.\n\n` +
      `Copy that, Engineer. Standing by for pit stop.`;
  } else {
    text =
      `🏎️ PitCrew Alert: Analysis complete.\n\n` +
      `Analyzed ${analysis.totalCommitsAnalyzed} recent commits but did not find an obvious code-level cause.\n` +
      `Recommend checking infrastructure, dependencies, and configuration for the Williams Telemetry Service.`;
  }

  await postJiraComment(issueKey, text);
}

async function postJiraComment(issueKey, text) {
  try {
    const adfBody = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text,
            },
          ],
        },
      ],
    };

    const res = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/comment`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: adfBody }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`PitCrew: failed to post Jira comment: ${res.status} - ${errText}`);
    } else {
      console.log(`PitCrew: Jira comment posted on ${issueKey}`);
    }
  } catch (e) {
    console.error('PitCrew: error posting Jira comment:', e);
  }
}

// =============================================================================
// Confluence: Simple Incident Report
// =============================================================================

async function createIncidentReport(issueKey, summary, analysis) {
  try {
    const spaceId = await getConfluenceSpaceId(CONFIG.CONFLUENCE_SPACE_KEY);
    if (!spaceId) {
      console.warn('PitCrew: INCIDENTS space not found, skipping Confluence report.');
      return;
    }

    const suspect = analysis.suspect;
    const bodyHtml = buildIncidentReportHtml(issueKey, summary, analysis, suspect);

    const res = await api.asApp().requestConfluence(
      route`/wiki/api/v2/pages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spaceId,
          status: 'current',
          title: `Incident Report - ${issueKey}`,
          body: {
            representation: 'storage',
            value: bodyHtml,
          },
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`PitCrew: failed to create Confluence page: ${res.status} - ${errText}`);
      return;
    }

    console.log(`PitCrew: Confluence incident report created for ${issueKey}`);
  } catch (e) {
    console.error('PitCrew: error creating Confluence incident report:', e);
  }
}

async function getConfluenceSpaceId(spaceKey) {
  try {
    const res = await api.asApp().requestConfluence(
      route`/wiki/api/v2/spaces?keys=${spaceKey}`
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`PitCrew: failed to fetch Confluence space: ${res.status} - ${errText}`);
      return null;
    }

    const data = await res.json();
    if (data.results && data.results.length > 0) {
      return data.results[0].id;
    }
    return null;
  } catch (e) {
    console.error('PitCrew: error looking up Confluence space ID:', e);
    return null;
  }
}

function buildIncidentReportHtml(issueKey, summary, analysis, suspect) {
  const safeSummary = escapeHtml(summary || '');
  const suspectHtml = suspect
    ? `<p><strong>Suspect commit:</strong> <code>${escapeHtml(suspect.hash)}</code> by ${escapeHtml(
        suspect.author
      )}</p>
       <p><strong>Confidence:</strong> ${suspect.confidence}%</p>`
    : '<p>No specific commit identified as root cause.</p>';

  return `
<h1>🏎️ Incident Report - ${escapeHtml(issueKey)}</h1>

<p><strong>Summary:</strong> ${safeSummary}</p>

<h2>Timeline</h2>
<ul>
  <li><strong>Incident detected:</strong> ${escapeHtml(new Date().toISOString())}</li>
  <li><strong>Analysis completed:</strong> ${escapeHtml(analysis.analysisTime)}</li>
</ul>

<h2>Root Cause</h2>
${suspectHtml}

<h2>Notes</h2>
<ul>
  <li>Telemetry service experienced a 500 error due to a logic bug in tire pressure calculation.</li>
  <li>Williams PitCrew automatically analyzed recent commits and flagged the suspect change.</li>
</ul>

<hr/>
<p><em>Report generated automatically by the Williams PitCrew Telemetry system.</em></p>
`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}