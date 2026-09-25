// Sample file for ERplorer demo
function login(username, password) {
  if (!username) {
    throw new Error('Username is required');
  }
  if (!password) {
    throw new Error('Password is required');
  }
  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  return { username, ok: true };
}

console.error('Login service initialized');
module.exports = { login };
