-- 074-late — functions, cross-table FKs, and triggers applied AFTER all tables exist.

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.episodes(id);

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_revises_belief_fkey FOREIGN KEY (revises_belief) REFERENCES public.content(id);

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_self_state_id_fkey FOREIGN KEY (self_state_id) REFERENCES public.self_states(id);

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.content(id);

ALTER TABLE ONLY public.contradictions
    ADD CONSTRAINT contradictions_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);

ALTER TABLE ONLY public.contradictions
    ADD CONSTRAINT contradictions_relationship_id_fkey FOREIGN KEY (relationship_id) REFERENCES public.entity_relationships(id);

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_first_memory_id_fkey FOREIGN KEY (first_memory_id) REFERENCES public.content(id);

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_from_entity_id_fkey FOREIGN KEY (from_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_invalidated_by_fkey FOREIGN KEY (invalidated_by) REFERENCES public.entity_relationships(id);

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_to_entity_id_fkey FOREIGN KEY (to_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES public.subcategories(id);

ALTER TABLE ONLY public.memory_edges
    ADD CONSTRAINT memory_edges_from_content_id_fkey FOREIGN KEY (from_content_id) REFERENCES public.content(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.memory_edges
    ADD CONSTRAINT memory_edges_to_content_id_fkey FOREIGN KEY (to_content_id) REFERENCES public.content(id) ON DELETE CASCADE;
