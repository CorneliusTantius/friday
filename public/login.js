const form = document.querySelector('#login-form');
const password = document.querySelector('#password');
const error = document.querySelector('#error');
const submit = form.querySelector('button[type="submit"]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  submit.disabled = true;
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign in failed');
    window.location.replace('/');
  } catch (cause) {
    error.textContent = cause.message;
    password.focus();
  } finally {
    submit.disabled = false;
  }
});
