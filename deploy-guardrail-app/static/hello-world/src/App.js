import React, { useEffect, useState } from 'react';
import { invoke } from '@forge/bridge';

// --- PREMIUM STYLES (Glassmorphism & Animations) ---
const styles = {
  container: {
    padding: '24px',
    fontFamily: '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    background: 'linear-gradient(135deg, #0F172A 0%, #1E293B 100%)', // Deep Space Blue
    color: '#FFFFFF',
    minHeight: '450px',
    borderRadius: '12px',
    boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
    position: 'relative',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '32px',
    borderBottom: '1px solid rgba(255,255,255,0.1)',
    paddingBottom: '20px',
  },
  title: {
    fontSize: '20px',
    fontWeight: '700',
    background: 'linear-gradient(90deg, #60A5FA, #A78BFA)', // Blue to Purple Gradient
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    textTransform: 'uppercase',
    letterSpacing: '1.5px',
  },
  scoreContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  scoreLabel: {
    fontSize: '12px',
    color: '#94A3B8',
    textTransform: 'uppercase',
    letterSpacing: '1px',
  },
  scoreValue: {
    fontSize: '28px',
    fontWeight: '800',
    textShadow: '0 0 20px rgba(255,255,255,0.2)',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.03)', // Glass effect
    backdropFilter: 'blur(10px)',
    border: '1px solid rgba(255, 255, 255, 0.05)',
    padding: '24px',
    borderRadius: '16px',
    marginBottom: '20px',
    transition: 'all 0.3s ease',
  },
  cardBlocked: {
    borderLeft: '4px solid #EF4444', // Red
    boxShadow: '0 0 30px rgba(239, 68, 68, 0.1)',
  },
  cardSuccess: {
    borderLeft: '4px solid #10B981', // Green
    boxShadow: '0 0 30px rgba(16, 185, 129, 0.1)',
  },
  codeBlock: {
    background: '#0B1120',
    padding: '16px',
    borderRadius: '8px',
    fontFamily: '"JetBrains Mono", monospace',
    fontSize: '13px',
    color: '#34D399', // Emerald Green
    whiteSpace: 'pre-wrap',
    marginTop: '16px',
    marginBottom: '20px',
    border: '1px solid rgba(255,255,255,0.1)',
    lineHeight: '1.5',
  },
  button: {
    background: 'linear-gradient(90deg, #3B82F6, #8B5CF6)',
    color: '#FFFFFF',
    border: 'none',
    padding: '14px 24px',
    borderRadius: '8px',
    fontWeight: '600',
    cursor: 'pointer',
    width: '100%',
    fontSize: '15px',
    transition: 'all 0.2s ease',
    boxShadow: '0 4px 12px rgba(59, 130, 246, 0.3)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '8px',
  },
  buttonDisabled: {
    background: '#334155',
    color: '#94A3B8',
    cursor: 'not-allowed',
    boxShadow: 'none',
  },
  aiBadge: {
    background: 'rgba(139, 92, 246, 0.2)', // Purple tint
    color: '#A78BFA',
    padding: '4px 10px',
    borderRadius: '20px',
    fontSize: '11px',
    fontWeight: '700',
    border: '1px solid rgba(139, 92, 246, 0.3)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
  },
  statusIcon: {
    fontSize: '20px',
    marginRight: '8px',
  },
  loader: {
    width: '18px',
    height: '18px',
    border: '2px solid rgba(255,255,255,0.3)',
    borderTop: '2px solid #FFFFFF',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  }
};

// Inject CSS for animations
const styleSheet = document.createElement("style");
styleSheet.innerText = `
  @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  @keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }
  @keyframes slideIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
`;
document.head.appendChild(styleSheet);

function App() {
  const [status, setStatus] = useState('LOADING');
  const [data, setData] = useState(null);
  const [isFixing, setIsFixing] = useState(false);

  useEffect(() => {
    checkRisk();
  }, []);

  const checkRisk = async () => {
    const result = await invoke('checkRisk');
    setData(result);
    setStatus(result.status);
  };

  const handleApplyFix = async () => {
    setIsFixing(true);
    await invoke('applyFix');
    await checkRisk();
    setIsFixing(false);
  };

  if (status === 'LOADING') {
    return (
      <div style={{ ...styles.container, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
        <div style={styles.loader}></div>
        <p style={{ marginTop: '16px', color: '#94A3B8', fontSize: '14px', animation: 'pulse 1.5s infinite' }}>Analyzing Deployment Risk...</p>
      </div>
    );
  }

  if (status === 'ERROR') {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.title}>Pit Crew Copilot</span>
          <span style={{ ...styles.scoreValue, color: '#EF4444' }}>ERROR</span>
        </div>
        <div style={{ ...styles.card, ...styles.cardBlocked, animation: 'slideIn 0.3s ease' }}>
          <strong style={{ color: '#EF4444', display: 'flex', alignItems: 'center' }}>
            <span style={styles.statusIcon}>⚠️</span> System Error
          </strong>
          <p style={{ color: '#CBD5E1', marginTop: '8px' }}>{data ? data.message : "Unknown Error"}</p>
        </div>
      </div>
    );
  }

  if (status === 'ALLOWED') {
    return (
      <div style={styles.container}>
        <div style={styles.header}>
          <span style={styles.title}>Pit Crew Copilot</span>
          <div style={styles.scoreContainer}>
            <span style={styles.scoreLabel}>Risk Score</span>
            <span style={{ ...styles.scoreValue, color: '#10B981' }}>{data.riskScore}</span>
          </div>
        </div>
        <div style={{ ...styles.card, ...styles.cardSuccess, animation: 'slideIn 0.5s ease' }}>
          <h3 style={{ margin: '0 0 8px 0', color: '#10B981', display: 'flex', alignItems: 'center' }}>
            <span style={styles.statusIcon}>✅</span> Ready for Takeoff
          </h3>
          <p style={{ margin: 0, fontSize: '14px', color: '#94A3B8', lineHeight: '1.5' }}>
            {data.message}
          </p>
        </div>
      </div>
    );
  }

  // BLOCKED STATE
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.title}>Pit Crew Copilot</span>
        <div style={styles.scoreContainer}>
          <span style={styles.scoreLabel}>Risk Score</span>
          <span style={{ ...styles.scoreValue, color: '#EF4444' }}>{data.riskScore}</span>
        </div>
      </div>

      {data.issues.map((issue) => (
        <div key={issue.id} style={{ ...styles.card, ...styles.cardBlocked, animation: 'slideIn 0.5s ease' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <strong style={{ color: '#EF4444', display: 'flex', alignItems: 'center' }}>
              <span style={styles.statusIcon}>⛔</span> DEPLOYMENT BLOCKED
            </strong>
          </div>

          <p style={{ margin: '0 0 20px 0', fontWeight: '600', fontSize: '16px', color: '#F1F5F9' }}>{issue.message}</p>

          {issue.aiFixAvailable && (
            <div style={{ background: 'rgba(15, 23, 42, 0.6)', padding: '20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center' }}>
                <span style={styles.aiBadge}>✨ AI Analysis</span>
              </div>
              <p style={{ fontSize: '14px', margin: '0 0 12px 0', color: '#CBD5E1', lineHeight: '1.6' }}>
                {issue.aiAnalysis}
              </p>

              <div style={styles.codeBlock}>
                {issue.codeDiff}
              </div>

              <button
                style={isFixing ? { ...styles.button, ...styles.buttonDisabled } : styles.button}
                onClick={handleApplyFix}
                disabled={isFixing}
              >
                {isFixing ? (
                  <>
                    <div style={styles.loader}></div>
                    Pit Crew Working...
                  </>
                ) : (
                  <>
                    <span>⚡</span> Apply Fix & Run Tests
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export default App;
