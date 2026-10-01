/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1.5s", "2m 30s")
 */
export function formatDuration(ms) {
  // Handle edge cases
  if (ms === null || ms === undefined) {
    return "N/A";
  }
  
  if (ms < 0) {
    return "0ms";
  }
  
  // Convert to appropriate units
  if (ms < 1000) {
    return `${ms}ms`;
  }
  
  if (ms < 60000) {
    const seconds = ms / 1000;
    return `${seconds % 1 === 0 ? seconds : seconds.toFixed(1)}s`;
  }
  
  const minutes = Math.floor(ms / 60000);
  const remainingSeconds = Math.floor((ms % 60000) / 1000);
  
  if (remainingSeconds === 0) {
    return `${minutes}m`;
  }
  
  return `${minutes}m ${remainingSeconds}s`;
}