BEGIN;
ALTER TABLE driver_mobile_actions DROP CONSTRAINT IF EXISTS driver_mobile_actions_kind_check;
ALTER TABLE driver_mobile_actions ADD CONSTRAINT driver_mobile_actions_kind_check CHECK(kind IN ('accept','checklist','fuel'));
ALTER TABLE fuel DROP CONSTRAINT IF EXISTS fuel_payment_method_check;
ALTER TABLE fuel ADD CONSTRAINT fuel_payment_method_check CHECK(payment_method IN ('unspecified','cash','card','debit','credit','agreement','internal'));
COMMIT;
