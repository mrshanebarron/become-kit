-- 027: Documentation comment defining canonical relation types
-- 2026-05-17
--
-- Per OMEGA (95.4% on LongMemEval) and Zep (71.2%), agent memory graphs
-- benefit from a small canonical vocabulary of supersession/contradiction
-- relation types ON TOP of free-form domain relations. Current
-- entity_relationships has 20 freeform types (uses, hosts, integrates_with,
-- built_with, etc.) but ZERO supersession-shape types.
--
-- This migration adds a comment to the column documenting the canonical set.
-- It does NOT enforce them - free-form remains supported. It steers future
-- writes toward consistency so traversal queries can find supersession chains
-- reliably.

COMMENT ON COLUMN entity_relationships.relation_type IS
  $$Free-form relation type. Canonical types for cross-tool consistency:

  DOMAIN RELATIONS (typical use):
    uses, integrates_with, hosts, built_with, related_to, part_of,
    manages, supports, works_on, requires, configures, contains

  TEMPORAL META-RELATIONS (preferred when applicable):
    supersedes      - new fact replaces older one (use with valid_until on old)
    contradicts     - new fact disputes older one (mark old confidence lower)
    derived_from    - this relationship was inferred from another
    confirms        - new observation reinforces existing relationship

  When asserting a fact that updates a prior relationship:
    1. Call vision_graph_relate with invalidate_previous=true (same-type)
    2. OR insert new + assert supersedes/contradicts between the two
    3. NEVER leave stale facts as valid_until=NULL alongside the new truth

  Per Zep/OMEGA LongMemEval: explicit supersession is what beats vector-
  only retrieval by 14+ points on knowledge-update questions.$$;
