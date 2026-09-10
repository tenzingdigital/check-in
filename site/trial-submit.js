// Feedback for the trial sign-up form (site/trial/) — nothing more.
//
// The rest of this site runs no JavaScript at all (see the docstring in
// tools/build-site.py for why, and why this file is the exception). Without
// it, submitting the form gives no sign anything is happening until the page
// navigates: on a slow connection that reads as broken, so people tap again
// and submit twice.
//
// This only disables the submit button and relabels it while the POST is in
// flight. It never calls preventDefault() and never touches the form's
// action, so if this script fails to load, is blocked, or throws, the form
// still submits exactly as if it were not here.
(function () {
  var form = document.getElementById('trial-signup');
  if (!form) return;
  form.addEventListener('submit', function () {
    var button = form.querySelector('button[type="submit"]');
    if (!button) return;
    button.disabled = true;
    button.textContent = 'Sending...';
  });
})();
