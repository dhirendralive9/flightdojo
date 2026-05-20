const cron = require('node-cron');
const SavedSearch = require('../models/SavedSearch');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { searchOffers } = require('./duffel');
const mailer = require('./mailer');

// Run the price-alert check.
// For each active saved search, re-query Duffel, compare prices, send alerts
// for drops ≥ alert_threshold_percent (default 10%).
// Throttled: max 1 alert per saved search per 7 days.
async function runPriceAlertCheck() {
  console.log('💹 Price-alert cron starting…');
  const searches = await SavedSearch.find({ active: true, archived_at: null }).limit(2000);
  let checked = 0, alertsSent = 0, errors = 0;

  for (const search of searches) {
    try {
      // Skip dates in the past
      if (new Date(search.depart_date) < new Date()) {
        search.active = false;
        await search.save();
        continue;
      }

      const result = await searchOffers({
        origin: search.origin,
        destination: search.destination,
        depart_date: search.depart_date,
        return_date: search.return_date,
        passengers: search.passengers,
        cabin_class: search.cabin_class
      });

      const cheapest = (result.offers || []).reduce((min, o) =>
        !min || parseFloat(o.total_amount) < parseFloat(min.total_amount) ? o : min, null);

      checked++;
      if (!cheapest) {
        search.last_checked_at = new Date();
        await search.save();
        continue;
      }

      const newPrice = parseFloat(cheapest.total_amount);
      const baseline = search.baseline_price || newPrice;
      const dropPct = (baseline - newPrice) / baseline;

      const oldCurrent = search.current_price;
      search.current_price = newPrice;
      search.current_currency = cheapest.total_currency;
      search.last_offer_id = cheapest.id;
      search.last_checked_at = new Date();

      // Send alert if drop crosses threshold AND we haven't recently alerted at this price
      const thresh = search.alert_threshold_percent || 0.10;
      const recentlyAlerted = search.last_alert_sent_at &&
        (Date.now() - search.last_alert_sent_at.getTime()) < 7 * 24 * 60 * 60 * 1000;

      if (dropPct >= thresh && !recentlyAlerted) {
        const user = await User.findById(search.user_id);
        if (user) {
          search.last_alert_sent_at = new Date();
          search.alert_last_price = newPrice;

          const route = `${search.origin} → ${search.destination}`;
          const savings = Math.round(baseline - newPrice);
          const pct = Math.round(dropPct * 100);
          const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
          const bookUrl = `${baseUrl}/offer/${cheapest.id}`;

          await Notification.push(user._id, {
            type: 'travel_reminder',
            title: `Price drop · ${route}`,
            body: `Down ${pct}% from your saved price. New low: ${cheapest.total_currency} ${Math.round(newPrice)} (save ${cheapest.total_currency} ${savings}).`,
            link: '/account/saved-searches'
          });

          await mailer.sendPriceDropAlert(user, {
            route,
            old_price: Math.round(baseline),
            new_price: Math.round(newPrice),
            currency: cheapest.total_currency,
            drop_percent: pct,
            depart_date: search.depart_date,
            return_date: search.return_date,
            book_url: bookUrl
          }).catch(() => {});

          alertsSent++;
        }
      }

      await search.save();
    } catch (err) {
      errors++;
      console.warn(`Price-alert check failed for search ${search._id}:`, err.message);
    }
  }

  console.log(`💹 Price-alert cron done: ${checked} checked, ${alertsSent} alerts sent, ${errors} errors`);
}

// Schedule: run daily at 09:00 UTC (configurable via env)
function startCron() {
  if (process.env.DISABLE_CRON === '1') {
    console.log('⏸  Cron disabled via DISABLE_CRON=1');
    return;
  }
  const schedule = process.env.PRICE_ALERT_CRON || '0 9 * * *';
  if (!cron.validate(schedule)) {
    console.warn(`⚠  Invalid PRICE_ALERT_CRON "${schedule}" — cron disabled`);
    return;
  }
  cron.schedule(schedule, () => {
    runPriceAlertCheck().catch(err => console.error('Price-alert cron crashed:', err));
  });
  console.log(`⏰ Price-alert cron scheduled: ${schedule}`);
}

module.exports = { runPriceAlertCheck, startCron };
