// Loaded on first run so the app opens with something to look at.

// The same pipeline as SAMPLE_SQL, written the way it would be in SAS: a DATA
// step, a PROC SORT, a PROC SQL join and a PROC SUMMARY, so every reader the
// SAS path has is exercised by the sample.
export const SAMPLE_SAS = `/* Revenue pipeline in SAS: raw orders -> cleaned -> enriched -> reported. */
/* Click any field chip to trace it back to the dataset it came from.      */

%let raw = ecommerce;

data staging.orders_clean;
  set &raw..orders (where=(status = 'paid'));
  order_id = id;
  amount   = amount_cents / 100;
  if channel = 'web' then channel_group = 'online';
  else channel_group = 'retail';
  drop id amount_cents;
run;

proc sort data=staging.orders_clean out=staging.orders_sorted;
  by customer_id;
run;

proc sql;
  create table staging.orders_enriched as
  select o.order_id,
         o.amount,
         o.channel_group,
         c.country,
         c.signup_date,
         coalesce(c.segment, 'unknown') as segment
    from staging.orders_sorted o
    left join crm.customers c
      on c.id = o.customer_id;
quit;

proc summary data=staging.orders_enriched nway;
  class country segment;
  var amount;
  output out=by_country sum(amount)=revenue n(amount)=order_count;
run;

data revenue_report;
  set by_country;
  avg_order_value = revenue / max(order_count, 1);
  keep country segment revenue order_count avg_order_value;
run;
`;

export const SAMPLE_SQL = `-- Revenue pipeline: raw orders -> cleaned -> enriched -> reported.
-- Click any field chip to trace it back to the table it came from.

create table staging.orders_clean as
select o.id                     as order_id,
       o.customer_id,
       o.amount_cents / 100.0   as amount,
       o.placed_at,
       case when o.channel = 'web' then 'online' else 'retail' end as channel_group
from ecommerce.orders o
where o.status = 'paid';

create table staging.orders_enriched as
select oc.order_id,
       oc.amount,
       oc.channel_group,
       c.country,
       c.signup_date,
       coalesce(c.segment, 'unknown') as segment
from staging.orders_clean oc
left join crm.customers c on c.id = oc.customer_id;

with by_country as (
  select country,
         segment,
         sum(amount)  as revenue,
         count(*)     as order_count
  from staging.orders_enriched
  group by country, segment
),
ranked as (
  select country,
         segment,
         revenue,
         order_count,
         revenue / nullif(order_count, 0) as avg_order_value
  from by_country
)
select r.country,
       r.segment,
       r.revenue,
       r.avg_order_value,
       r.revenue / sum(r.revenue) over () as revenue_share
from ranked r
order by r.revenue desc;
`;
