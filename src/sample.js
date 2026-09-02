// Loaded on first run so the app opens with something to look at.
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
