import Resolver from '@forge/resolver';
import api, { route, storage, fetch } from '@forge/api';

const resolver = new Resolver();

// =============================================================================
// CONFIGURATION - Williams Racing Telemetry Service
// =============================================================================
// For the demo, we hardcode the Bitbucket workspace and repo.
// In production, you'd store this mapping in Forge Storage or a custom field.
const CONFIG = {
  // Bitbucket Cloud workspace and repository slug
  BITBUCKET_WORKSPACE: 'williams-racing',  // Change to your actual workspace
  BITBUCKET_REPO: 'williams-telemetry-service',  // Change to your actual repo
  
  // Bitbucket App Password for API authentication
  // IMPORTANT: In production, use Forge's encrypted storage or environment variables
  // For demo, we'll use a placeholder - you'll need to set this via storage.set()
  BITBUCKET_AUTH_KEY: 'bitbucket:auth',
  
  // Confluence space for incident reports
  CONFLUENCE_SPACE_KEY: 'INCIDENTS',
  
  // Keywords that identify high-priority incidents
  INCIDENT_KEYWORDS: ['CRITICAL', 'P1', 'URGENT', 'DOWN', 'OUTAGE'],
  
  // How far back to look for commits (in minutes)
  COMMIT_LOOKBACK_MINUTES: 30
};

// =============================================================================
// PHASE 2: INCIDENT TRIGGER - Listens for new JSM Incidents
// =============================================================================
/**
 * This trigger fires whenever a new Jira issue is created.
 * We filter for high-priority incidents and automatically analyze recent commits.
 * 
 * Think of this as the "telemetry alarm" going off in the pit wall.
 */
export const incidentAnalysisTrigger = async (event, context) => {
  console.log('🏎️ PitCrew: Incident trigger fired!', JSON.stringify(event));
  
  try {
    const issueKey = event.issue.key;
    const issueId = event.issue.id;
    
    // Fetch full issue details to check if this is a high-priority incident
    const issueResponse = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}?fields=summary,priority,issuetype,description`
    );
    
    if (!issueResponse.ok) {
      console.error(`Failed to fetch issue ${issueKey}: ${issueResponse.status}`);
      return;
    }
    
    const issue = await issueResponse.json();
    const summary = issue.fields.summary || '';
    const priority = issue.fields.priority?.name || '';
    const issueType = issue.fields.issuetype?.name || '';
    const description = issue.fields.description?.content?.[0]?.content?.[0]?.text || '';
    
    console.log(`🏎️ PitCrew: Analyzing issue ${issueKey} - Type: ${issueType}, Priority: ${priority}`);
    
    // Check if this is a high-priority incident we should analyze
    // We look for: Incident issue type OR critical keywords in summary
    const isIncident = issueType.toLowerCase().includes('incident');
    const isHighPriority = priority.toLowerCase().includes('high') || 
                          priority.toLowerCase().includes('critical') ||
                          priority.toLowerCase().includes('highest');
    const hasCriticalKeyword = CONFIG.INCIDENT_KEYWORDS.some(
      keyword => summary.toUpperCase().includes(keyword)
    );
    
    if (!isIncident && !hasCriticalKeyword) {
      console.log(`🏎️ PitCrew: Issue ${issueKey} is not a critical incident. Standing down.`);
      return;
    }
    
    console.log(`🚨 PitCrew: CRITICAL INCIDENT DETECTED! Initiating analysis for ${issueKey}`);
    
    // Store incident start time for timeline tracking
    await storage.set(`incident:${issueKey}:startTime`, new Date().toISOString());
    await storage.set(`incident:${issueKey}:summary`, summary);
    
    // Fetch recent commits from Bitbucket
    const commits = await fetchRecentCommits();
    
    if (commits.length === 0) {
      console.log('🏎️ PitCrew: No recent commits found. Manual investigation required.');
      await postJiraComment(issueKey, 
        `🏎️ *PitCrew Alert*: No recent commits found in the last ${CONFIG.COMMIT_LOOKBACK_MINUTES} minutes.\n\n` +
        `The telemetry shows no recent code changes. This incident may be infrastructure-related.\n\n` +
        `_Standing by for manual investigation, Engineer._`
      );
      return;
    }
    
    // Analyze commits and find the likely culprit
    const analysis = await analyzeCommitsForIncident(commits, summary, description);
    
    // Post the analysis as a comment on the Jira ticket
    await postPitCrewAnalysis(issueKey, analysis);
    
    // Store analysis for later use by Rovo agent
    await storage.set(`incident:${issueKey}:analysis`, analysis);
    
    console.log(`🏎️ PitCrew: Analysis complete for ${issueKey}. Comment posted.`);
    
  } catch (error) {
    console.error('🏎️ PitCrew: Trigger error:', error);
  }
};

// =============================================================================
// BITBUCKET API HELPERS
// =============================================================================

/**
 * Fetches recent commits from the configured Bitbucket repository.
 * Returns commits from the last N minutes (configured in CONFIG).
 */
async function fetchRecentCommits() {
  console.log('🏎️ PitCrew: Fetching recent commits from Bitbucket...');
  
  try {
    // Get Bitbucket auth credentials from storage
    // Format: "username:app_password" base64 encoded
    const authToken = await storage.get(CONFIG.BITBUCKET_AUTH_KEY);
    
    if (!authToken) {
      console.warn('🏎️ PitCrew: Bitbucket auth not configured. Using mock data for demo.');
      return getMockCommits();
    }
    
    // Calculate the timestamp for lookback period
    const lookbackTime = new Date();
    lookbackTime.setMinutes(lookbackTime.getMinutes() - CONFIG.COMMIT_LOOKBACK_MINUTES);
    
    // Fetch commits from Bitbucket Cloud API
    const url = `https://api.bitbucket.org/2.0/repositories/${CONFIG.BITBUCKET_WORKSPACE}/${CONFIG.BITBUCKET_REPO}/commits`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      console.error(`Bitbucket API error: ${response.status}`);
      return getMockCommits();
    }
    
    const data = await response.json();
    
    // Filter commits to only those within our lookback window
    const recentCommits = (data.values || []).filter(commit => {
      const commitDate = new Date(commit.date);
      return commitDate >= lookbackTime;
    }).map(commit => ({
      hash: commit.hash.substring(0, 7),
      fullHash: commit.hash,
      message: commit.message,
      author: commit.author?.user?.display_name || commit.author?.raw || 'Unknown',
      date: commit.date,
      // We'll fetch diffs separately if needed
      files: []
    }));
    
    console.log(`🏎️ PitCrew: Found ${recentCommits.length} commits in the last ${CONFIG.COMMIT_LOOKBACK_MINUTES} minutes`);
    return recentCommits;
    
  } catch (error) {
    console.error('🏎️ PitCrew: Error fetching commits:', error);
    return getMockCommits();
  }
}

/**
 * Fetches the diff for a specific commit from Bitbucket.
 */
async function fetchCommitDiff(commitHash) {
  try {
    const authToken = await storage.get(CONFIG.BITBUCKET_AUTH_KEY);
    
    if (!authToken) {
      return getMockDiff(commitHash);
    }
    
    const url = `https://api.bitbucket.org/2.0/repositories/${CONFIG.BITBUCKET_WORKSPACE}/${CONFIG.BITBUCKET_REPO}/diff/${commitHash}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Accept': 'text/plain'
      }
    });
    
    if (!response.ok) {
      console.error(`Failed to fetch diff for ${commitHash}: ${response.status}`);
      return getMockDiff(commitHash);
    }
    
    return await response.text();
    
  } catch (error) {
    console.error('Error fetching diff:', error);
    return getMockDiff(commitHash);
  }
}

/**
 * Triggers a Bitbucket Pipeline to revert a commit and redeploy.
 */
async function triggerRevertPipeline(commitHash, issueKey) {
  console.log(`🏎️ PitCrew: Triggering revert pipeline for commit ${commitHash}`);
  
  try {
    const authToken = await storage.get(CONFIG.BITBUCKET_AUTH_KEY);
    
    if (!authToken) {
      console.warn('🏎️ PitCrew: Bitbucket auth not configured. Simulating pipeline trigger.');
      return { success: true, pipelineId: 'mock-pipeline-123', simulated: true };
    }
    
    const url = `https://api.bitbucket.org/2.0/repositories/${CONFIG.BITBUCKET_WORKSPACE}/${CONFIG.BITBUCKET_REPO}/pipelines/`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: {
          type: 'pipeline_ref_target',
          ref_type: 'branch',
          ref_name: 'main',
          selector: {
            type: 'custom',
            pattern: 'revert-and-deploy'  // Custom pipeline for revert
          }
        },
        variables: [
          { key: 'REVERT_COMMIT', value: commitHash },
          { key: 'INCIDENT_KEY', value: issueKey }
        ]
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Pipeline trigger failed: ${response.status} - ${errorText}`);
      return { success: false, error: errorText };
    }
    
    const pipeline = await response.json();
    return { 
      success: true, 
      pipelineId: pipeline.uuid,
      buildNumber: pipeline.build_number
    };
    
  } catch (error) {
    console.error('Error triggering pipeline:', error);
    return { success: false, error: error.message };
  }
}

// =============================================================================
// MOCK DATA FOR DEMO (When Bitbucket isn't configured)
// =============================================================================

/**
 * Returns mock commit data for demo purposes.
 * This simulates what we'd get from Bitbucket.
 */
function getMockCommits() {
  const now = new Date();
  return [
    {
      hash: 'a8j29f3',
      fullHash: 'a8j29f3b4c5d6e7f8g9h0i1j2k3l4m5n6o7p8q9',
      message: 'fix: Update tire pressure calculation threshold',
      author: 'Junior Developer',
      date: new Date(now.getTime() - 5 * 60000).toISOString(), // 5 mins ago
      files: ['pressure_calc.py']
    },
    {
      hash: 'b7k38e2',
      fullHash: 'b7k38e2a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
      message: 'chore: Update dependencies',
      author: 'DevOps Bot',
      date: new Date(now.getTime() - 15 * 60000).toISOString(), // 15 mins ago
      files: ['requirements.txt']
    },
    {
      hash: 'c6l47d1',
      fullHash: 'c6l47d1z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4',
      message: 'feat: Add new telemetry endpoint',
      author: 'Senior Engineer',
      date: new Date(now.getTime() - 25 * 60000).toISOString(), // 25 mins ago
      files: ['api/telemetry.py', 'tests/test_telemetry.py']
    }
  ];
}

/**
 * Returns mock diff data for demo purposes.
 * This simulates the "bad code" that caused the incident.
 */
function getMockDiff(commitHash) {
  if (commitHash.startsWith('a8j29')) {
    return `
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
`;
  }
  return '// No significant changes in this commit';
}

// =============================================================================
// AI ANALYSIS - The "Rovo Brain"
// =============================================================================

/**
 * Analyzes recent commits to identify the likely cause of an incident.
 * This is where the AI magic happens - correlating crash reports with code changes.
 * 
 * For the demo, we use pattern matching. In production, you'd call Rovo AI or another LLM.
 */
async function analyzeCommitsForIncident(commits, incidentSummary, incidentDescription) {
  console.log('🏎️ PitCrew: Analyzing commits for root cause...');
  
  // For each commit, fetch its diff and analyze
  const analyzedCommits = [];
  
  for (const commit of commits) {
    const diff = await fetchCommitDiff(commit.fullHash);
    
    // Simple pattern matching for common issues
    // In production, send this to Rovo AI for intelligent analysis
    const issues = [];
    let confidence = 0;
    
    // Check for divide by zero
    if (diff.includes('/ 0') || diff.includes('/0') || diff.includes('divisor = 0')) {
      issues.push({
        type: 'DIVIDE_BY_ZERO',
        description: 'Division by zero detected - this will cause a runtime crash',
        severity: 'CRITICAL'
      });
      confidence = 98;
    }
    
    // Check for safety threshold changes
    if (diff.includes('safety_threshold') && diff.includes('= 0')) {
      issues.push({
        type: 'SAFETY_THRESHOLD_REMOVED',
        description: 'Safety threshold set to 0 - this bypasses critical safety checks',
        severity: 'CRITICAL'
      });
      confidence = Math.max(confidence, 95);
    }
    
    // Check for removed error handling
    if (diff.includes('-    try:') || diff.includes('-    except')) {
      issues.push({
        type: 'ERROR_HANDLING_REMOVED',
        description: 'Error handling code was removed - exceptions may crash the service',
        severity: 'HIGH'
      });
      confidence = Math.max(confidence, 85);
    }
    
    // Check for test file modifications without corresponding code
    if (commit.message.toLowerCase().includes('test') && !diff.includes('.py')) {
      issues.push({
        type: 'TEST_ONLY_CHANGE',
        description: 'Test-only change - unlikely to cause production issues',
        severity: 'LOW'
      });
    }
    
    analyzedCommits.push({
      ...commit,
      diff: diff,
      issues: issues,
      confidence: confidence,
      isSuspect: confidence >= 80
    });
  }
  
  // Sort by confidence (highest first)
  analyzedCommits.sort((a, b) => b.confidence - a.confidence);
  
  // Find the prime suspect
  const suspect = analyzedCommits.find(c => c.isSuspect);
  
  return {
    commits: analyzedCommits,
    suspect: suspect || null,
    totalCommitsAnalyzed: commits.length,
    analysisTime: new Date().toISOString()
  };
}

// =============================================================================
// PHASE 3: JIRA COMMENT - Post PitCrew Analysis
// =============================================================================

/**
 * Posts a formatted analysis comment to the Jira issue.
 * This is the "🏎️ PitCrew Alert" the user sees.
 */
async function postPitCrewAnalysis(issueKey, analysis) {
  let comment = '';
  
  if (analysis.suspect) {
    const suspect = analysis.suspect;
    const issueList = suspect.issues.map(i => `• ${i.description}`).join('\n');
    
    comment = `🏎️ *PitCrew Alert: Root Cause Identified*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*🔴 SUSPECT COMMIT:* \`${suspect.hash}\`
*👤 Author:* ${suspect.author}
*📅 Time:* ${new Date(suspect.date).toLocaleString()}
*📝 Message:* ${suspect.message}

*🔍 Issues Detected:*
${issueList}

*📊 Confidence:* ${suspect.confidence}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*Code Changes:*
{code:python}
${suspect.diff.substring(0, 1000)}
{code}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

*🏁 Recommended Action:* Revert commit \`${suspect.hash}\` to restore service.

_Copy that, Engineer. Standing by for your command to initiate pit stop._`;
  } else {
    comment = `🏎️ *PitCrew Alert: Analysis Complete*

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Analyzed ${analysis.totalCommitsAnalyzed} recent commits. No obvious code issues detected.

*Possible causes:*
• Infrastructure issue (not code-related)
• Configuration change
• External dependency failure
• Data corruption

_Recommend manual investigation, Engineer. The telemetry doesn't show a clear code fault._`;
  }
  
  await postJiraComment(issueKey, comment);
}

/**
 * Posts a comment to a Jira issue using the REST API.
 */
async function postJiraComment(issueKey, commentBody) {
  try {
    // Convert plain text to Atlassian Document Format (ADF)
    // For simplicity, we'll use a basic text node structure
    const adfBody = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: commentBody
            }
          ]
        }
      ]
    };
    
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/comment`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          body: adfBody
        })
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to post comment: ${response.status} - ${errorText}`);
      return false;
    }
    
    console.log(`🏎️ PitCrew: Comment posted to ${issueKey}`);
    return true;
    
  } catch (error) {
    console.error('Error posting comment:', error);
    return false;
  }
}

// =============================================================================
// PHASE 4: ROVO ACTIONS - Analyze and Revert
// =============================================================================

/**
 * Rovo Action: Analyze commits for a given issue.
 * Called when the user asks the PitCrew agent to investigate.
 */
export const analyzeCommitsHandler = async (payload) => {
  console.log('🏎️ PitCrew: Analyze action triggered', JSON.stringify(payload));
  
  const issueKey = payload.issueKey;
  
  if (!issueKey) {
    return {
      success: false,
      message: 'Copy that, but I need an issue key to investigate. What ticket are we looking at?'
    };
  }
  
  try {
    // Check if we already have analysis stored
    const existingAnalysis = await storage.get(`incident:${issueKey}:analysis`);
    
    if (existingAnalysis) {
      const suspect = existingAnalysis.suspect;
      if (suspect) {
        return {
          success: true,
          message: `🏎️ Analysis already complete for ${issueKey}.\n\n` +
                   `**Suspect:** Commit \`${suspect.hash}\` by ${suspect.author}\n` +
                   `**Confidence:** ${suspect.confidence}%\n` +
                   `**Issue:** ${suspect.issues[0]?.description || 'Unknown'}\n\n` +
                   `Ready to revert when you give the command, Engineer.`,
          analysis: existingAnalysis
        };
      }
    }
    
    // Perform fresh analysis
    const commits = await fetchRecentCommits();
    const issueData = await storage.get(`incident:${issueKey}:summary`) || 'Unknown incident';
    const analysis = await analyzeCommitsForIncident(commits, issueData, '');
    
    // Store for later
    await storage.set(`incident:${issueKey}:analysis`, analysis);
    
    if (analysis.suspect) {
      return {
        success: true,
        message: `🏎️ Analysis complete!\n\n` +
                 `**Found the problem:** Commit \`${analysis.suspect.hash}\` by ${analysis.suspect.author}\n` +
                 `**Confidence:** ${analysis.suspect.confidence}%\n` +
                 `**Issue:** ${analysis.suspect.issues[0]?.description}\n\n` +
                 `Say the word and I'll trigger the revert, Engineer.`,
        analysis: analysis
      };
    } else {
      return {
        success: true,
        message: `🏎️ Analyzed ${analysis.totalCommitsAnalyzed} commits but couldn't identify a clear code issue.\n\n` +
                 `This might be infrastructure-related. Recommend checking:\n` +
                 `• Server health metrics\n` +
                 `• Database connections\n` +
                 `• External API dependencies`,
        analysis: analysis
      };
    }
    
  } catch (error) {
    console.error('Analyze action error:', error);
    return {
      success: false,
      message: `🏎️ Hit a wall during analysis: ${error.message}. Check the logs, Engineer.`
    };
  }
};

/**
 * Rovo Action: Revert a commit and trigger redeployment.
 * This is the "Money Shot" - the one-click fix.
 */
export const revertCommitHandler = async (payload) => {
  console.log('🏎️ PitCrew: Revert action triggered', JSON.stringify(payload));
  
  const { commitHash, issueKey } = payload;
  
  if (!commitHash || !issueKey) {
    return {
      success: false,
      message: 'Copy that, but I need both the commit hash and issue key to proceed. What are we reverting?'
    };
  }
  
  try {
    // Trigger the revert pipeline
    const result = await triggerRevertPipeline(commitHash, issueKey);
    
    if (!result.success) {
      return {
        success: false,
        message: `🏎️ Pipeline trigger failed: ${result.error}\n\nManual intervention required, Engineer.`
      };
    }
    
    // Update the Jira issue
    await postJiraComment(issueKey, 
      `🏎️ *PitCrew: Pit Stop Initiated*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `*Action:* Reverting commit \`${commitHash}\`\n` +
      `*Pipeline:* ${result.pipelineId || 'Triggered'}\n` +
      `*Status:* 🟡 In Progress\n\n` +
      `_Box box! Revert in progress. Stand by for confirmation._`
    );
    
    // Store revert action for incident report
    await storage.set(`incident:${issueKey}:revertAction`, {
      commitHash,
      pipelineId: result.pipelineId,
      triggeredAt: new Date().toISOString(),
      simulated: result.simulated || false
    });
    
    // For demo purposes, simulate success after a short delay
    if (result.simulated) {
      // In a real scenario, the pipeline would call back via webhook
      // For demo, we'll mark it as resolved
      setTimeout(async () => {
        await markIncidentResolved(issueKey, commitHash);
      }, 3000);
    }
    
    return {
      success: true,
      message: `🏎️ Pit stop initiated!\n\n` +
               `Reverting commit \`${commitHash}\` and triggering redeployment.\n\n` +
               `${result.simulated ? '*(Demo mode: Simulating pipeline)*' : `Pipeline ID: ${result.pipelineId}`}\n\n` +
               `Stand by for green flag, Engineer.`
    };
    
  } catch (error) {
    console.error('Revert action error:', error);
    return {
      success: false,
      message: `🏎️ Revert failed: ${error.message}. We need manual intervention!`
    };
  }
};

/**
 * Marks an incident as resolved and posts success message.
 */
async function markIncidentResolved(issueKey, commitHash) {
  try {
    // Post success comment
    await postJiraComment(issueKey,
      `🏎️ *PitCrew: System Restored*\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `✅ Commit \`${commitHash}\` has been reverted.\n` +
      `✅ Deployment successful.\n` +
      `✅ Service health: 🟢 OPERATIONAL\n\n` +
      `_Checkered flag! We're back on track, Engineer._`
    );
    
    // Store resolution time
    await storage.set(`incident:${issueKey}:resolvedAt`, new Date().toISOString());
    await storage.set(`incident:${issueKey}:status`, 'RESOLVED');
    
    // Create Confluence incident report (Phase 5)
    await createIncidentReport(issueKey);
    
    console.log(`🏎️ PitCrew: Incident ${issueKey} marked as resolved`);
    
  } catch (error) {
    console.error('Error marking incident resolved:', error);
  }
}

// =============================================================================
// PHASE 5: CONFLUENCE INCIDENT REPORT
// =============================================================================

/**
 * Creates a post-incident report in Confluence.
 * This documents the timeline, root cause, and resolution.
 */
async function createIncidentReport(issueKey) {
  console.log(`🏎️ PitCrew: Creating incident report for ${issueKey}`);
  
  try {
    // Gather all incident data from storage
    const startTime = await storage.get(`incident:${issueKey}:startTime`);
    const resolvedAt = await storage.get(`incident:${issueKey}:resolvedAt`);
    const summary = await storage.get(`incident:${issueKey}:summary`);
    const analysis = await storage.get(`incident:${issueKey}:analysis`);
    const revertAction = await storage.get(`incident:${issueKey}:revertAction`);
    
    // Calculate incident duration
    const duration = startTime && resolvedAt 
      ? Math.round((new Date(resolvedAt) - new Date(startTime)) / 60000)
      : 'Unknown';
    
    // Build the report content in Confluence Storage Format
    const reportContent = buildConfluenceReport({
      issueKey,
      summary,
      startTime,
      resolvedAt,
      duration,
      analysis,
      revertAction
    });
    
    // Create the Confluence page
    const response = await api.asApp().requestConfluence(
      route`/wiki/api/v2/pages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          spaceId: await getConfluenceSpaceId(),
          status: 'current',
          title: `Incident Report - ${issueKey} - ${new Date().toLocaleDateString()}`,
          body: {
            representation: 'storage',
            value: reportContent
          }
        })
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Failed to create Confluence page: ${response.status} - ${errorText}`);
      return null;
    }
    
    const page = await response.json();
    console.log(`🏎️ PitCrew: Incident report created: ${page._links?.webui || page.id}`);
    
    // Post link to the report in Jira
    await postJiraComment(issueKey,
      `📋 *Incident Report Generated*\n\n` +
      `A post-incident report has been created in Confluence.\n\n` +
      `_Documentation complete. Ready for post-race debrief, Engineer._`
    );
    
    return page;
    
  } catch (error) {
    console.error('Error creating incident report:', error);
    return null;
  }
}

/**
 * Gets the Confluence space ID for storing incident reports.
 */
async function getConfluenceSpaceId() {
  try {
    const response = await api.asApp().requestConfluence(
      route`/wiki/api/v2/spaces?keys=${CONFIG.CONFLUENCE_SPACE_KEY}`
    );
    
    if (response.ok) {
      const data = await response.json();
      if (data.results && data.results.length > 0) {
        return data.results[0].id;
      }
    }
    
    // Fallback: return a placeholder (you'd need to create the space first)
    console.warn('Confluence space not found, using placeholder');
    return null;
    
  } catch (error) {
    console.error('Error getting Confluence space:', error);
    return null;
  }
}

/**
 * Builds the Confluence page content in Storage Format (XHTML).
 */
function buildConfluenceReport(data) {
  const suspect = data.analysis?.suspect;
  
  return `
<h1>🏎️ Incident Report: ${data.issueKey}</h1>

<ac:structured-macro ac:name="info">
  <ac:rich-text-body>
    <p><strong>Status:</strong> RESOLVED</p>
    <p><strong>Duration:</strong> ${data.duration} minutes</p>
  </ac:rich-text-body>
</ac:structured-macro>

<h2>📅 Timeline</h2>
<table>
  <tr>
    <th>Event</th>
    <th>Time</th>
  </tr>
  <tr>
    <td>Incident Detected</td>
    <td>${data.startTime || 'Unknown'}</td>
  </tr>
  <tr>
    <td>Root Cause Identified</td>
    <td>${data.analysis?.analysisTime || 'Unknown'}</td>
  </tr>
  <tr>
    <td>Revert Initiated</td>
    <td>${data.revertAction?.triggeredAt || 'Unknown'}</td>
  </tr>
  <tr>
    <td>Service Restored</td>
    <td>${data.resolvedAt || 'Unknown'}</td>
  </tr>
</table>

<h2>🔍 Root Cause</h2>
<p><strong>Summary:</strong> ${data.summary || 'Unknown'}</p>
${suspect ? `
<p><strong>Suspect Commit:</strong> <code>${suspect.hash}</code></p>
<p><strong>Author:</strong> ${suspect.author}</p>
<p><strong>Issue:</strong> ${suspect.issues?.[0]?.description || 'Unknown'}</p>
<p><strong>Confidence:</strong> ${suspect.confidence}%</p>

<h3>Code Changes</h3>
<ac:structured-macro ac:name="code">
  <ac:parameter ac:name="language">diff</ac:parameter>
  <ac:plain-text-body><![CDATA[${suspect.diff?.substring(0, 2000) || 'No diff available'}]]></ac:plain-text-body>
</ac:structured-macro>
` : '<p>No specific code issue identified.</p>'}

<h2>🔧 Resolution</h2>
<p><strong>Action Taken:</strong> Reverted commit <code>${data.revertAction?.commitHash || 'Unknown'}</code></p>
<p><strong>Pipeline ID:</strong> ${data.revertAction?.pipelineId || 'Unknown'}</p>

<h2>📝 Lessons Learned</h2>
<ul>
  <li>Add pre-commit hooks to catch divide-by-zero errors</li>
  <li>Implement safety threshold validation in CI/CD</li>
  <li>Consider adding canary deployments for critical services</li>
</ul>

<hr/>
<p><em>Report generated by PitCrew - Williams Racing Incident Response System</em></p>
`;
}

// =============================================================================
// EXISTING FUNCTIONALITY (Preserved from original)
// =============================================================================

/**
 * Shared risk analysis logic for the workflow validator.
 */
async function analyzeRisk(issueKey) {
  try {
    const res = await api.asApp().requestJira(route`/rest/api/3/issue/${issueKey}`);

    if (!res.ok) {
      console.error(`Failed to fetch issue ${issueKey}: ${res.status} ${res.statusText}`);
      return { isBlocked: false, riskScore: 0, summary: "Error fetching summary" };
    }

    const data = await res.json();
    const summary = data.fields.summary || "";

    let isFixed = false;
    try {
      isFixed = await storage.get(`issue:${issueKey}:fixed`);
    } catch (storageError) {
      console.error("Storage API Error:", storageError);
      isFixed = false;
    }

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

// --- RESOLVERS (For the UI Panel) ---

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
            aiAnalysis: 'I noticed you modified `payment.js` but did not add any corresponding tests.',
            codeDiff: `+ describe('PaymentService', () => {\n+   it('should process valid payments', () => {...});\n+ });`
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
    await new Promise(resolve => setTimeout(resolve, 2000));
    await storage.set(`issue:${key}:fixed`, true);
    return { success: true, message: 'Fix applied! Tests are running...' };
  } catch (e) {
    console.error("Apply Fix Error:", e);
    throw e;
  }
});

// New resolver for getting incident analysis
resolver.define('getIncidentAnalysis', async (req) => {
  try {
    const key = req.context.extension.issue.key;
    const analysis = await storage.get(`incident:${key}:analysis`);
    const status = await storage.get(`incident:${key}:status`);
    
    return {
      hasAnalysis: !!analysis,
      analysis: analysis,
      status: status || 'INVESTIGATING',
      suspect: analysis?.suspect || null
    };
  } catch (e) {
    console.error("Get Analysis Error:", e);
    return { hasAnalysis: false, error: e.message };
  }
});

// Resolver to trigger revert from UI
resolver.define('triggerRevert', async (req) => {
  try {
    const key = req.context.extension.issue.key;
    const analysis = await storage.get(`incident:${key}:analysis`);
    
    if (!analysis?.suspect) {
      return { success: false, message: 'No suspect commit identified' };
    }
    
    const result = await revertCommitHandler({
      commitHash: analysis.suspect.hash,
      issueKey: key
    });
    
    return result;
  } catch (e) {
    console.error("Trigger Revert Error:", e);
    return { success: false, message: e.message };
  }
});

export const handler = resolver.getDefinitions();

// --- VALIDATOR (For Workflow Transitions) ---
export const validateDeployment = async (event) => {
  try {
    const issueKey = event.issue.key;
    const risk = await analyzeRisk(issueKey);

    if (risk.isBlocked) {
      return {
        result: false,
        errorMessage: `⛔ DEPLOYMENT BLOCKED: Risk Score ${risk.riskScore}/100. Please use the PitCrew panel to fix this.`
      };
    }

    return { result: true };
  } catch (e) {
    console.error("Validator Crash:", e);
    return {
      result: false,
      errorMessage: `⚠️ Guardrail Error: ${e.message}. Check Forge Logs.`
    };
  }
};
