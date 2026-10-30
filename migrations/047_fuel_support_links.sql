BEGIN;
-- Read-only relationships. Evidence and private objects retain their original identity.
CREATE OR REPLACE VIEW financial_support_links AS
 SELECT company_id,'fuel'::text kind,fuel_id::bigint target_id,id entry_id FROM financial_support_entries WHERE fuel_id IS NOT NULL
 UNION SELECT company_id,'cost',cost_version_id,id FROM financial_support_entries WHERE cost_version_id IS NOT NULL
 UNION SELECT company_id,'source',source_id,id FROM financial_support_entries WHERE source_id IS NOT NULL
 UNION
 SELECT a.company_id,'fuel',s.fuel_id,e.id FROM economic_source_allocations a
 JOIN economic_sources s ON s.id=a.source_id AND s.company_id=a.company_id
 JOIN financial_support_entries e ON e.company_id=a.company_id AND
 (e.source_id=s.id OR e.cost_version_id IN (SELECT id FROM trip_cost_versions WHERE trip_cost_item_id=a.cost_item_id AND company_id=a.company_id))
 WHERE s.fuel_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM economic_source_reversals r WHERE r.allocation_id=a.id)
 UNION
 SELECT a.company_id,'source',s.id,e.id FROM economic_source_allocations a
 JOIN economic_sources s ON s.id=a.source_id AND s.company_id=a.company_id
 JOIN financial_support_entries e ON e.company_id=a.company_id AND
 (e.fuel_id=s.fuel_id OR e.cost_version_id IN (SELECT id FROM trip_cost_versions WHERE trip_cost_item_id=a.cost_item_id AND company_id=a.company_id))
 WHERE NOT EXISTS(SELECT 1 FROM economic_source_reversals r WHERE r.allocation_id=a.id)
 UNION
 SELECT a.company_id,'cost',v.id,e.id FROM economic_source_allocations a
 JOIN economic_sources s ON s.id=a.source_id AND s.company_id=a.company_id
 JOIN trip_cost_versions v ON v.trip_cost_item_id=a.cost_item_id AND v.company_id=a.company_id
 JOIN financial_support_entries e ON e.company_id=a.company_id AND (e.fuel_id=s.fuel_id OR e.source_id=s.id)
 WHERE NOT EXISTS(SELECT 1 FROM economic_source_reversals r WHERE r.allocation_id=a.id)
 UNION
 SELECT s.company_id,'source',s.id,e.id FROM economic_sources s
 JOIN financial_support_entries e ON e.fuel_id=s.fuel_id AND e.company_id=s.company_id;
COMMIT;
