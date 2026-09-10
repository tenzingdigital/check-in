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
  var button = form.querySelector('button[type="submit"]');
  var originalLabel = button ? button.textContent : null;
  form.addEventListener('submit', function () {
    if (!button) return;
    button.disabled = true;
    button.textContent = 'Sending...';
  });
  // Submit, then press Back: Safari and Firefox restore the page from the
  // back-forward cache exactly as it was left, button and all, rather than
  // reloading it — so without this the form is stuck disabled and reading
  // "Sending..." and cannot be resubmitted. `event.persisted` is true only
  // for a bfcache restore, never a fresh load, so this never touches a
  // button that was never disabled in the first place.
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted || !button) return;
    button.disabled = false;
    button.textContent = originalLabel;
  });
})();
