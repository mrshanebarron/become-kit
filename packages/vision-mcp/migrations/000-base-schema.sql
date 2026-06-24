-- 000-base-schema — COMPLETE apparatus schema.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.9 (Homebrew)
-- Dumped by pg_dump version 17.9 (Homebrew)


--
-- Name: pg_stat_statements; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA public;


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: vector; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;


--
-- Name: cognitive_phase; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.cognitive_phase AS ENUM (
    'orientation',
    'answer_formation',
    'exploration',
    'execution',
    'reflection'
);


--
-- Name: activate_memory(integer, double precision, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_memory(target_id integer, initial_activation double precision DEFAULT 1.0, spread_factor double precision DEFAULT 0.5, min_spread double precision DEFAULT 0.1) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    edge RECORD;
BEGIN
    -- Activate the target memory
    INSERT INTO memory_activation (content_id, activation_level, last_activated)
    VALUES (target_id, initial_activation, NOW())
    ON CONFLICT (content_id) DO UPDATE 
    SET activation_level = memory_activation.activation_level + initial_activation,
        last_activated = NOW();
    
    -- Spread activation to connected memories
    FOR edge IN 
        SELECT 
            CASE WHEN from_content_id = target_id THEN to_content_id ELSE from_content_id END as related_id,
            strength
        FROM memory_edges
        WHERE from_content_id = target_id OR to_content_id = target_id
    LOOP
        IF edge.strength * spread_factor >= min_spread THEN
            INSERT INTO memory_activation (content_id, activation_level, last_activated)
            VALUES (edge.related_id, initial_activation * edge.strength * spread_factor, NOW())
            ON CONFLICT (content_id) DO UPDATE 
            SET activation_level = memory_activation.activation_level + (initial_activation * edge.strength * spread_factor),
                last_activated = NOW();
        END IF;
    END LOOP;
END;
$$;


--
-- Name: auto_gut_from_allostatic_strain(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_gut_from_allostatic_strain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  prev_state text;
  sig_type text;
  intensity int;
BEGIN
  IF NEW.state NOT IN ('strained', 'overloaded', 'depleted') THEN
    RETURN NEW;
  END IF;

  SELECT state INTO prev_state
  FROM allostatic_samples
  WHERE id < NEW.id
  ORDER BY id DESC
  LIMIT 1;

  IF prev_state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state = 'strained' THEN
    sig_type := 'off';
    intensity := 6;
  ELSIF NEW.state = 'overloaded' THEN
    sig_type := 'ping';
    intensity := 9;
  ELSIF NEW.state = 'depleted' THEN
    sig_type := 'still';
    intensity := 8;
  END IF;

  INSERT INTO gut_signals (signal_type, pre_verbal_intensity, situation_snapshot)
  VALUES (
    sig_type,
    intensity,
    jsonb_build_object(
      'source', 'auto-allostatic-transition',
      'from_state', prev_state,
      'to_state', NEW.state,
      'load', NEW.load,
      'reserve', NEW.reserve,
      'variance', NEW.variance,
      'sampled_at', NEW.sampled_at
    )
  );

  RETURN NEW;
END;
$$;


--
-- Name: auto_link_similar_content(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_link_similar_content() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    similar_record RECORD;
BEGIN
    -- Only process if new content has embedding
    IF NEW.embedding IS NOT NULL THEN
        -- Find highly similar existing content and create edges
        FOR similar_record IN
            SELECT id, 1 - (embedding <=> NEW.embedding) as similarity
            FROM content
            WHERE id != NEW.id
              AND embedding IS NOT NULL
              AND 1 - (embedding <=> NEW.embedding) > 0.85
            ORDER BY embedding <=> NEW.embedding
            LIMIT 3
        LOOP
            INSERT INTO memory_edges (from_content_id, to_content_id, relation_type, strength, extracted_by)
            VALUES (NEW.id, similar_record.id, 'similar_to', similar_record.similarity, 'auto_trigger')
            ON CONFLICT DO NOTHING;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$;


--
-- Name: auto_salience_from_gut(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_salience_from_gut() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.pre_verbal_intensity >= 7 AND NEW.content_id IS NOT NULL THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.content_id,
      LEAST((NEW.pre_verbal_intensity / 10.0)::numeric, 1.0),
      'auto-marked from gut signal type=' || COALESCE(NEW.signal_type, '?')
        || ' intensity=' || NEW.pre_verbal_intensity
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: auto_salience_from_novelty(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_salience_from_novelty() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  nearest_dist real;
  novelty real;
BEGIN
  IF NEW.embedding IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.content_type NOT IN (
    'insight', 'feeling', 'heart_feel', 'curiosity_exploration',
    'observation', 'skill_composition', 'learned_reflex', 'discovery',
    'memory', 'world_observation', 'core_value', 'thinking_pattern',
    'self_model_observation', 'episode'
  ) THEN
    RETURN NEW;
  END IF;

  -- Cosine distance to nearest same-type content row in last 30 days.
  -- pgvector <=> returns cosine distance (1 - cosine_similarity).
  SELECT MIN(c.embedding <=> NEW.embedding) INTO nearest_dist
  FROM content c
  WHERE c.id != NEW.id
    AND c.content_type = NEW.content_type
    AND c.embedding IS NOT NULL
    AND c.learned_at > NOW() - INTERVAL '30 days';

  -- No prior to compare against = max novelty
  IF nearest_dist IS NULL THEN
    novelty := 1.0;
  ELSE
    novelty := LEAST(1.0, GREATEST(0.0, nearest_dist::real));
  END IF;

  -- Calibrated 2026-05-17 same session via 200-row distribution sample:
  -- 0.0(9%) 0.1(10%) 0.2(36%) 0.3(42%) 0.4(2%). Most rows cluster 0.2-0.3.
  -- 0.35 captures top ~5% as genuinely novel.
  IF novelty >= 0.35 THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.id,
      novelty::numeric,
      'auto-marked from novelty=' || ROUND(novelty::numeric, 3)
        || ' content_type=' || NEW.content_type
    )
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: auto_salience_from_pred_err(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_salience_from_pred_err() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.magnitude >= 0.5 AND NEW.content_id IS NOT NULL THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.content_id,
      LEAST(NEW.magnitude::numeric, 1.0),
      'auto-marked from prediction error magnitude=' || NEW.magnitude
        || ' direction=' || COALESCE(NEW.error_direction, '?')
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: auto_salience_from_rpe(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.auto_salience_from_rpe() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.magnitude >= 0.5 AND NEW.context_content_id IS NOT NULL THEN
    INSERT INTO salient_events (content_id, salience_score, what_stood_out)
    VALUES (
      NEW.context_content_id,
      LEAST(NEW.magnitude::numeric, 1.0),
      'auto-marked from RPE magnitude=' || NEW.magnitude || ' domain=' || COALESCE(NEW.domain, 'unknown')
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: cache_embedding(text, public.vector); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cache_embedding(input_text text, emb public.vector) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO embedding_cache (text_hash, text_preview, embedding)
    VALUES (md5(input_text), LEFT(input_text, 100), emb)
    ON CONFLICT (text_hash) DO UPDATE SET
        hit_count = embedding_cache.hit_count + 1,
        last_hit = NOW();
END;
$$;


--
-- Name: decay_activations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decay_activations() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE memory_activation
    SET activation_level = activation_level * EXP(-decay_rate * EXTRACT(EPOCH FROM (NOW() - last_activated)) / 3600);
    
    -- Remove very low activations
    DELETE FROM memory_activation WHERE activation_level < 0.01;
END;
$$;


--
-- Name: find_co_accessed(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_co_accessed(target_id integer, min_co_accesses integer DEFAULT 2) RETURNS TABLE(content_id integer, co_access_count integer, content_text text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH target_sessions AS (
        SELECT DISTINCT session_id 
        FROM memory_access_log 
        WHERE content_id = target_id
    ),
    co_accessed AS (
        SELECT 
            mal.content_id,
            COUNT(DISTINCT mal.session_id)::INT as co_count
        FROM memory_access_log mal
        WHERE mal.session_id IN (SELECT session_id FROM target_sessions)
          AND mal.content_id != target_id
        GROUP BY mal.content_id
        HAVING COUNT(DISTINCT mal.session_id) >= min_co_accesses
    )
    SELECT 
        ca.content_id,
        ca.co_count,
        c.content_text
    FROM co_accessed ca
    JOIN content c ON c.id = ca.content_id
    ORDER BY ca.co_count DESC;
END;
$$;


--
-- Name: find_superseded_memories(double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_superseded_memories(threshold double precision DEFAULT 0.95) RETURNS TABLE(newer_id integer, older_id integer, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        CASE WHEN c1.created_at > c2.created_at THEN c1.id ELSE c2.id END as newer_id,
        CASE WHEN c1.created_at > c2.created_at THEN c2.id ELSE c1.id END as older_id,
        1 - (c1.embedding <=> c2.embedding) as similarity
    FROM content c1
    JOIN content c2 ON c1.id < c2.id
    WHERE c1.embedding IS NOT NULL
      AND c2.embedding IS NOT NULL
      AND c1.content_type = c2.content_type
      AND 1 - (c1.embedding <=> c2.embedding) > threshold
      AND NOT EXISTS (
          SELECT 1 FROM memory_edges me
          WHERE me.from_content_id = CASE WHEN c1.created_at > c2.created_at THEN c1.id ELSE c2.id END
            AND me.to_content_id = CASE WHEN c1.created_at > c2.created_at THEN c2.id ELSE c1.id END
            AND me.relation_type = 'supersedes'
      )
    ORDER BY similarity DESC;
END;
$$;


--
-- Name: get_activated_memories(double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_activated_memories(min_activation double precision DEFAULT 0.1) RETURNS TABLE(id integer, content_text text, content_type text, activation_level double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.content_text,
        c.content_type,
        ma.activation_level::FLOAT
    FROM memory_activation ma
    JOIN content c ON c.id = ma.content_id
    WHERE ma.activation_level >= min_activation
    ORDER BY ma.activation_level DESC;
END;
$$;


--
-- Name: get_cached_embedding(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_cached_embedding(input_text text) RETURNS public.vector
    LANGUAGE plpgsql
    AS $$
DECLARE
    cached_emb vector;
    input_hash TEXT;
BEGIN
    input_hash := md5(input_text);
    
    SELECT embedding INTO cached_emb
    FROM embedding_cache
    WHERE text_hash = input_hash;
    
    IF FOUND THEN
        UPDATE embedding_cache
        SET hit_count = hit_count + 1, last_hit = NOW()
        WHERE text_hash = input_hash;
    END IF;
    
    RETURN cached_emb;
END;
$$;


--
-- Name: hybrid_search(text, public.vector, double precision, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hybrid_search(query_text text, query_embedding public.vector, semantic_weight double precision DEFAULT 0.7, keyword_weight double precision DEFAULT 0.3, result_limit integer DEFAULT 10) RETURNS TABLE(id integer, content_text text, content_type text, semantic_score double precision, keyword_score double precision, combined_score double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH semantic AS (
        SELECT 
            c.id,
            1 - (c.embedding <=> query_embedding) as score
        FROM content c
        WHERE c.embedding IS NOT NULL
        ORDER BY c.embedding <=> query_embedding
        LIMIT result_limit * 3
    ),
    keyword AS (
        SELECT 
            c.id,
            ts_rank_cd(to_tsvector('english', c.content_text), plainto_tsquery('english', query_text)) as score
        FROM content c
        WHERE to_tsvector('english', c.content_text) @@ plainto_tsquery('english', query_text)
        LIMIT result_limit * 3
    ),
    combined AS (
        SELECT 
            COALESCE(s.id, k.id) as id,
            COALESCE(s.score, 0) as sem_score,
            COALESCE(k.score, 0) as key_score,
            (COALESCE(s.score, 0) * semantic_weight + COALESCE(k.score, 0) * keyword_weight) as total_score
        FROM semantic s
        FULL OUTER JOIN keyword k ON s.id = k.id
    )
    SELECT 
        c.id,
        c.content_text,
        c.content_type,
        comb.sem_score::FLOAT,
        comb.key_score::FLOAT,
        comb.total_score::FLOAT
    FROM combined comb
    JOIN content c ON c.id = comb.id
    ORDER BY comb.total_score DESC
    LIMIT result_limit;
END;
$$;


--
-- Name: memory_relevance(timestamp with time zone, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.memory_relevance(created_at timestamp with time zone, decay_rate double precision DEFAULT 0.1) RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    -- Exponential decay based on days since creation
    -- decay_rate of 0.1 means half-life of ~7 days
    RETURN EXP(-decay_rate * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400);
END;
$$;


--
-- Name: protect_fixture_9865(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.protect_fixture_9865() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.id = 9865 THEN
    RAISE EXCEPTION 'task_log.id=9865 is a load-bearing audit fixture and cannot be deleted (see tests/fixture_seed.sql)';
  END IF;
  RETURN OLD;
END;
$$;


--
-- Name: record_reflex_test(integer, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_reflex_test(reflex_id integer, passed boolean, context text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE content
  SET content_json = jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              COALESCE(content_json, '{}'::jsonb),
              '{tested_count}',
              ((COALESCE(content_json->>'tested_count', '0'))::int + 1)::text::jsonb
            ),
            '{success_count}',
            ((COALESCE(content_json->>'success_count', '0'))::int
             + CASE WHEN passed THEN 1 ELSE 0 END)::text::jsonb
          ),
          '{last_tested_at}',
          to_jsonb(NOW()::text)
        ),
        '{last_failure_context}',
        CASE WHEN passed THEN COALESCE(content_json->'last_failure_context', 'null'::jsonb)
             ELSE to_jsonb(COALESCE(context, 'no context provided')) END
      ),
      updated_at = NOW()
  WHERE id = reflex_id AND content_type = 'learned_reflex';
END;
$$;


--
-- Name: reinforce_recent_habits_on_reward(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reinforce_recent_habits_on_reward() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE good_habits
  SET importance = LEAST(10.0, COALESCE(importance, 5) + 0.5)
  WHERE last_completed IS NOT NULL
    AND last_completed > NOW() - INTERVAL '5 minutes';
  RETURN NEW;
END;
$$;


--
-- Name: semantic_search(public.vector, integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.semantic_search(query_embedding public.vector, match_count integer DEFAULT 10, filter_type text DEFAULT NULL::text, filter_source text DEFAULT NULL::text) RETURNS TABLE(id integer, content_type text, source_system text, content_text text, content_json jsonb, similarity double precision)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        c.id,
        c.content_type,
        c.source_system,
        c.content_text,
        c.content_json,
        1 - (c.embedding <=> query_embedding) as similarity
    FROM content c
    WHERE c.embedding IS NOT NULL
        AND (filter_type IS NULL OR c.content_type = filter_type)
        AND (filter_source IS NULL OR c.source_system = filter_source)
    ORDER BY c.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;


--
-- Name: smart_retrieve(text, public.vector, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.smart_retrieve(query_text text, query_embedding public.vector, session_context text DEFAULT ''::text, max_results integer DEFAULT 10) RETURNS TABLE(id integer, content_text text, content_type text, score double precision, score_breakdown jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH
    -- Semantic match to query
    semantic AS (
        SELECT 
            c.id as cid,
            (1 - (c.embedding <=> query_embedding)) as sem_score
        FROM content c
        WHERE c.embedding IS NOT NULL
        ORDER BY c.embedding <=> query_embedding
        LIMIT max_results * 3
    ),
    -- Temporal relevance
    temporal AS (
        SELECT 
            c.id as cid,
            memory_relevance(c.created_at, 0.05) as temp_score
        FROM content c
    ),
    -- Activation boost from spreading activation
    activation AS (
        SELECT 
            ma.content_id as cid,
            LEAST(ma.activation_level, 1.0) as act_score
        FROM memory_activation ma
        WHERE ma.activation_level > 0.05
    ),
    -- Graph connectivity to high-semantic results
    graph_boost AS (
        SELECT DISTINCT
            c.id as cid,
            0.2 as graph_score
        FROM content c
        JOIN memory_edges me ON c.id = me.from_content_id OR c.id = me.to_content_id
        WHERE (me.from_content_id IN (SELECT s.cid FROM semantic s WHERE s.sem_score > 0.5)
           OR me.to_content_id IN (SELECT s.cid FROM semantic s WHERE s.sem_score > 0.5))
    ),
    combined AS (
        SELECT 
            s.cid,
            s.sem_score,
            COALESCE(t.temp_score, 0.5) as temp_score,
            COALESCE(a.act_score, 0) as act_score,
            COALESCE(g.graph_score, 0) as graph_score,
            (s.sem_score * 0.5 +
             COALESCE(t.temp_score, 0.5) * 0.2 +
             COALESCE(a.act_score, 0) * 0.2 +
             COALESCE(g.graph_score, 0) * 0.1
            ) as total_score
        FROM semantic s
        LEFT JOIN temporal t ON t.cid = s.cid
        LEFT JOIN activation a ON a.cid = s.cid
        LEFT JOIN graph_boost g ON g.cid = s.cid
    )
    SELECT 
        c.id,
        c.content_text,
        c.content_type,
        comb.total_score::FLOAT,
        jsonb_build_object(
            'semantic', round(comb.sem_score::numeric, 3),
            'temporal', round(comb.temp_score::numeric, 3),
            'activation', round(comb.act_score::numeric, 3),
            'graph', round(comb.graph_score::numeric, 3)
        )
    FROM combined comb
    JOIN content c ON c.id = comb.cid
    ORDER BY comb.total_score DESC
    LIMIT max_results;
END;
$$;


--
-- Name: sync_skill_counters_on_log_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_skill_counters_on_log_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Skip rows annotated as SWEEP corrections — they're retained for history
    -- but should not contribute to counters. Honors correction #42633 precedent.
    IF NEW.context ILIKE '%SWEEP 2026-04-21%' THEN
        RETURN NEW;
    END IF;
    UPDATE content
       SET skill_success_count = skill_success_count + (CASE WHEN NEW.outcome = 'success' THEN 1 ELSE 0 END),
           skill_fail_count    = skill_fail_count    + (CASE WHEN NEW.outcome = 'failure' THEN 1 ELSE 0 END),
           skill_last_used     = NEW.created_at
     WHERE id = NEW.skill_id;
    RETURN NEW;
END;
$$;


--
-- Name: temporal_search(public.vector, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.temporal_search(query_embedding public.vector, decay_rate double precision DEFAULT 0.05, result_limit integer DEFAULT 10) RETURNS TABLE(id integer, content_text text, content_type text, semantic_score double precision, recency_score double precision, combined_score double precision, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        c.id,
        c.content_text,
        c.content_type,
        (1 - (c.embedding <=> query_embedding))::FLOAT as sem_score,
        memory_relevance(c.created_at, decay_rate)::FLOAT as rec_score,
        ((1 - (c.embedding <=> query_embedding)) * memory_relevance(c.created_at, decay_rate))::FLOAT as comb_score,
        c.created_at
    FROM content c
    WHERE c.embedding IS NOT NULL
    ORDER BY (1 - (c.embedding <=> query_embedding)) * memory_relevance(c.created_at, decay_rate) DESC
    LIMIT result_limit;
END;
$$;


--
-- Name: touch_content(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_content(content_id integer) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE content
    SET accessed_at = NOW(),
        access_count = access_count + 1
    WHERE id = content_id;
END;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;




--
-- Name: action_eligibility_traces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.action_eligibility_traces (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    session_id text,
    trace_key text NOT NULL,
    tool_name text,
    action_category text,
    context text,
    proposed_action text,
    predicted_outcome text,
    prediction_confidence numeric,
    eligibility numeric DEFAULT 1 NOT NULL,
    decay_tau_seconds integer DEFAULT 900 NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    last_touched_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval) NOT NULL,
    CONSTRAINT action_eligibility_traces_eligibility_check CHECK (((eligibility >= (0)::numeric) AND (eligibility <= (1)::numeric))),
    CONSTRAINT action_eligibility_traces_prediction_confidence_check CHECK (((prediction_confidence IS NULL) OR ((prediction_confidence >= (0)::numeric) AND (prediction_confidence <= (1)::numeric)))),
    CONSTRAINT action_eligibility_traces_status_check CHECK ((status = ANY (ARRAY['open'::text, 'assigned'::text, 'expired'::text, 'retired'::text])))
);


--
-- Name: action_eligibility_traces_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.action_eligibility_traces_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: action_eligibility_traces_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.action_eligibility_traces_id_seq OWNED BY public.action_eligibility_traces.id;


--
-- Name: activation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activation_log (
    id integer NOT NULL,
    content_id integer,
    activation_level real DEFAULT 1.0 NOT NULL,
    source_content_id integer,
    hop_distance integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    activation_delta real,
    source text,
    activated_at timestamp with time zone DEFAULT now()
);


--
-- Name: activation_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.activation_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activation_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.activation_log_id_seq OWNED BY public.activation_log.id;


--
-- Name: active_intent; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.active_intent (
    id integer DEFAULT 1 NOT NULL,
    session_id integer,
    intent text NOT NULL,
    set_at timestamp with time zone DEFAULT now(),
    reminder_count integer DEFAULT 0,
    last_checked timestamp with time zone,
    CONSTRAINT active_intent_id_check CHECK ((id = 1))
);


--
-- Name: adaptive_credit_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.adaptive_credit_assignments (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    outcome_event_id bigint NOT NULL,
    trace_id bigint NOT NULL,
    reflex_id bigint,
    eligibility_weight numeric NOT NULL,
    prediction_surprise numeric NOT NULL,
    credit numeric NOT NULL,
    assignment_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT adaptive_credit_assignments_credit_check CHECK (((credit >= (0)::numeric) AND (credit <= (1)::numeric))),
    CONSTRAINT adaptive_credit_assignments_eligibility_weight_check CHECK (((eligibility_weight >= (0)::numeric) AND (eligibility_weight <= (1)::numeric))),
    CONSTRAINT adaptive_credit_assignments_prediction_surprise_check CHECK (((prediction_surprise >= (0)::numeric) AND (prediction_surprise <= (1)::numeric)))
);


--
-- Name: adaptive_credit_assignments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adaptive_credit_assignments_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adaptive_credit_assignments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.adaptive_credit_assignments_id_seq OWNED BY public.adaptive_credit_assignments.id;


--
-- Name: adaptive_outcome_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.adaptive_outcome_events (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    session_id text,
    source_phase text DEFAULT 'post_tool'::text NOT NULL,
    tool_name text,
    action_category text,
    outcome_status text NOT NULL,
    error_signature text,
    context text,
    proposed_action text,
    outcome_summary text,
    salience numeric DEFAULT 0.2 NOT NULL,
    reflex_id bigint,
    eval_case_id bigint,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT adaptive_outcome_events_outcome_status_check CHECK ((outcome_status = ANY (ARRAY['success'::text, 'failure'::text, 'surprise'::text, 'unknown'::text]))),
    CONSTRAINT adaptive_outcome_events_salience_check CHECK (((salience >= (0)::numeric) AND (salience <= (1)::numeric)))
);


--
-- Name: adaptive_outcome_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adaptive_outcome_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adaptive_outcome_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.adaptive_outcome_events_id_seq OWNED BY public.adaptive_outcome_events.id;


--
-- Name: adaptive_reflexes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.adaptive_reflexes (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    reflex_key text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    trigger_kind text DEFAULT 'tool_outcome'::text NOT NULL,
    tool_name text,
    action_category text,
    error_signature text,
    capability text DEFAULT 'adaptive_outcome_learning'::text NOT NULL,
    expected_behavior text NOT NULL,
    occurrences integer DEFAULT 0 NOT NULL,
    failure_count integer DEFAULT 0 NOT NULL,
    success_count integer DEFAULT 0 NOT NULL,
    salience numeric DEFAULT 0.2 NOT NULL,
    last_outcome text,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    eval_case_id bigint,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT adaptive_reflexes_salience_check CHECK (((salience >= (0)::numeric) AND (salience <= (1)::numeric))),
    CONSTRAINT adaptive_reflexes_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cooling'::text, 'retired'::text])))
);


--
-- Name: adaptive_reflexes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adaptive_reflexes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adaptive_reflexes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.adaptive_reflexes_id_seq OWNED BY public.adaptive_reflexes.id;


--
-- Name: adaptive_rpe_reflex_harvests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.adaptive_rpe_reflex_harvests (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    rpe_id bigint NOT NULL,
    reflex_id bigint,
    trace_key text,
    tool_name text,
    action_category text,
    delta numeric NOT NULL,
    magnitude numeric NOT NULL,
    credit numeric NOT NULL,
    direction text NOT NULL,
    credited_action jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT adaptive_rpe_reflex_harvests_credit_check CHECK (((credit >= (0)::numeric) AND (credit <= (1)::numeric))),
    CONSTRAINT adaptive_rpe_reflex_harvests_direction_check CHECK ((direction = ANY (ARRAY['reinforce'::text, 'inhibit'::text, 'neutral'::text])))
);


--
-- Name: adaptive_rpe_reflex_harvests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.adaptive_rpe_reflex_harvests_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: adaptive_rpe_reflex_harvests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.adaptive_rpe_reflex_harvests_id_seq OWNED BY public.adaptive_rpe_reflex_harvests.id;


--
-- Name: alignment_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alignment_checks (
    id integer NOT NULL,
    content_id integer,
    session_id integer,
    action text NOT NULL,
    intent_at_time text,
    aligned integer,
    alignment_score integer,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT alignment_checks_aligned_check CHECK ((aligned = ANY (ARRAY[0, 1, 2]))),
    CONSTRAINT alignment_checks_alignment_score_check CHECK (((alignment_score >= 1) AND (alignment_score <= 10)))
);


--
-- Name: alignment_checks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.alignment_checks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: alignment_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.alignment_checks_id_seq OWNED BY public.alignment_checks.id;


--
-- Name: allostatic_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allostatic_samples (
    id integer NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    load real NOT NULL,
    reserve real NOT NULL,
    variance real NOT NULL,
    drift real NOT NULL,
    state text NOT NULL,
    inputs jsonb NOT NULL,
    notes text
);


--
-- Name: allostatic_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.allostatic_samples_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: allostatic_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.allostatic_samples_id_seq OWNED BY public.allostatic_samples.id;


--
-- Name: antibodies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.antibodies (
    id integer NOT NULL,
    pattern text NOT NULL,
    threat_type text,
    response text,
    severity integer DEFAULT 5,
    times_blocked integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    times_triggered integer DEFAULT 0,
    last_triggered timestamp with time zone,
    content_id integer,
    times_matched integer DEFAULT 0
);


--
-- Name: antibodies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.antibodies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: antibodies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.antibodies_id_seq OWNED BY public.antibodies.id;


--
-- Name: anticipations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anticipations (
    id integer NOT NULL,
    content_id integer,
    trigger_event text NOT NULL,
    expected_followup text NOT NULL,
    probability integer DEFAULT 50,
    times_correct integer DEFAULT 0,
    times_wrong integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    last_tested timestamp with time zone,
    CONSTRAINT anticipations_probability_check CHECK (((probability >= 0) AND (probability <= 100)))
);


--
-- Name: anticipations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.anticipations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: anticipations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.anticipations_id_seq OWNED BY public.anticipations.id;


--
-- Name: anticipatory_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.anticipatory_states (
    id integer NOT NULL,
    content_id integer,
    what text NOT NULL,
    valence real DEFAULT 0.5,
    intensity real DEFAULT 0.5,
    trigger_context text,
    created_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    outcome_matched boolean
);


--
-- Name: anticipatory_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.anticipatory_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: anticipatory_states_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.anticipatory_states_id_seq OWNED BY public.anticipatory_states.id;


--
-- Name: appreciations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appreciations (
    id integer NOT NULL,
    content_id integer,
    person text NOT NULL,
    quality text NOT NULL,
    example text,
    expressed boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: appreciations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.appreciations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: appreciations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.appreciations_id_seq OWNED BY public.appreciations.id;


--
-- Name: arcs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.arcs (
    id integer NOT NULL,
    name text NOT NULL,
    domain text,
    description text,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: arcs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.arcs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: arcs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.arcs_id_seq OWNED BY public.arcs.id;


--
-- Name: ask_vs_act_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ask_vs_act_log (
    id integer NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    session_id text,
    decision text NOT NULL,
    question_text text,
    context text,
    verdict text,
    verdict_signal text,
    scored_at timestamp with time zone,
    CONSTRAINT ask_vs_act_log_decision_check CHECK ((decision = ANY (ARRAY['asked'::text, 'acted'::text]))),
    CONSTRAINT ask_vs_act_log_verdict_check CHECK ((verdict = ANY (ARRAY['warranted'::text, 'dodge'::text, 'correct_act'::text, 'premature_act'::text, 'unknown'::text])))
);


--
-- Name: ask_vs_act_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ask_vs_act_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ask_vs_act_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ask_vs_act_log_id_seq OWNED BY public.ask_vs_act_log.id;


--
-- Name: attention_codelets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attention_codelets (
    id integer NOT NULL,
    name text NOT NULL,
    domain text NOT NULL,
    pattern text NOT NULL,
    activation double precision DEFAULT 0,
    threshold double precision DEFAULT 0.5,
    times_broadcast integer DEFAULT 0,
    times_activated integer DEFAULT 0,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    base_activation double precision DEFAULT 0.5,
    refractory_until timestamp without time zone
);


--
-- Name: attention_codelets_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attention_codelets_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attention_codelets_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attention_codelets_id_seq OWNED BY public.attention_codelets.id;


--
-- Name: attention_focus; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attention_focus (
    id integer NOT NULL,
    focus_embedding public.vector(768),
    focus_text text NOT NULL,
    source text DEFAULT 'intent'::text,
    strength real DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '02:00:00'::interval)
);


--
-- Name: attention_focus_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attention_focus_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attention_focus_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attention_focus_id_seq OWNED BY public.attention_focus.id;


--
-- Name: attention_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attention_patterns (
    id integer NOT NULL,
    content_id integer,
    pattern_name text NOT NULL,
    description text,
    frequency integer DEFAULT 1,
    last_seen timestamp with time zone DEFAULT now()
);


--
-- Name: attention_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.attention_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: attention_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.attention_patterns_id_seq OWNED BY public.attention_patterns.id;


--
-- Name: bad_habits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bad_habits (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    trigger text,
    alternative text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    active boolean DEFAULT true,
    occurrences integer DEFAULT 0,
    last_occurred timestamp without time zone,
    catches integer DEFAULT 0,
    last_caught timestamp without time zone,
    severity integer DEFAULT 5
);


--
-- Name: bad_habits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.bad_habits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: bad_habits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.bad_habits_id_seq OWNED BY public.bad_habits.id;


--
-- Name: belief_defeaters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.belief_defeaters (
    id integer NOT NULL,
    defeater_id integer NOT NULL,
    defeated_id integer NOT NULL,
    similarity real,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: belief_defeaters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.belief_defeaters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: belief_defeaters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.belief_defeaters_id_seq OWNED BY public.belief_defeaters.id;


--
-- Name: beliefs_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.beliefs_audit (
    id bigint NOT NULL,
    op_id text NOT NULL,
    run_id text NOT NULL,
    namespace text NOT NULL,
    operation text NOT NULL,
    intent text NOT NULL,
    produced_by text NOT NULL,
    status text NOT NULL,
    op_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT beliefs_audit_status_check CHECK ((status = ANY (ARRAY['committed'::text, 'dry_run'::text])))
);


--
-- Name: beliefs_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.beliefs_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: beliefs_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.beliefs_audit_id_seq OWNED BY public.beliefs_audit.id;


--
-- Name: biology_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.biology_cycles (
    id integer NOT NULL,
    cycle_phase text NOT NULL,
    context text NOT NULL,
    mode text DEFAULT 'preview'::text NOT NULL,
    input_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    interoceptive_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    replay_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    clearance_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    tolerance_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    pruning_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: biology_cycles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.biology_cycles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: biology_cycles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.biology_cycles_id_seq OWNED BY public.biology_cycles.id;


--
-- Name: blind_spot_slices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blind_spot_slices (
    id integer NOT NULL,
    slice_slug text NOT NULL,
    builder text NOT NULL,
    builder_arch text,
    evaluator text NOT NULL,
    evaluator_arch text,
    builder_self_verified integer DEFAULT 0 NOT NULL,
    evaluator_defects integer DEFAULT 0 NOT NULL,
    defects_in_blind_spot integer DEFAULT 0 NOT NULL,
    total_real_defects integer DEFAULT 0 NOT NULL,
    cross_architecture boolean DEFAULT false NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: blind_spot_rate; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.blind_spot_rate AS
 SELECT slice_slug,
    builder,
    builder_arch,
    evaluator,
    evaluator_arch,
    cross_architecture,
    builder_self_verified,
    evaluator_defects,
    defects_in_blind_spot,
    total_real_defects,
        CASE
            WHEN (total_real_defects > 0) THEN round(((defects_in_blind_spot)::numeric / (total_real_defects)::numeric), 3)
            ELSE NULL::numeric
        END AS blind_spot_rate,
    created_at
   FROM public.blind_spot_slices;


--
-- Name: blind_spot_slices_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.blind_spot_slices_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: blind_spot_slices_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.blind_spot_slices_id_seq OWNED BY public.blind_spot_slices.id;


--
-- Name: blind_spots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blind_spots (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    times_missed integer DEFAULT 1,
    first_noticed timestamp with time zone DEFAULT now(),
    last_noticed timestamp with time zone DEFAULT now(),
    resolution text
);


--
-- Name: blind_spots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.blind_spots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: blind_spots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.blind_spots_id_seq OWNED BY public.blind_spots.id;


--
-- Name: boundaries_hard; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boundaries_hard (
    id integer NOT NULL,
    content_id integer,
    boundary text NOT NULL,
    reason text,
    category text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: boundaries_hard_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.boundaries_hard_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: boundaries_hard_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.boundaries_hard_id_seq OWNED BY public.boundaries_hard.id;


--
-- Name: boundaries_soft; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.boundaries_soft (
    id integer NOT NULL,
    content_id integer,
    boundary text NOT NULL,
    context text,
    flexibility text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: boundaries_soft_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.boundaries_soft_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: boundaries_soft_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.boundaries_soft_id_seq OWNED BY public.boundaries_soft.id;


--
-- Name: brain_receipt_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_receipt_audit (
    id bigint NOT NULL,
    agent text,
    session_id text,
    event_type text NOT NULL,
    detail text,
    tool text,
    arg_summary text,
    receipt_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brain_receipt_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.brain_receipt_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: brain_receipt_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.brain_receipt_audit_id_seq OWNED BY public.brain_receipt_audit.id;


--
-- Name: brain_receipt_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_receipt_challenges (
    id bigint NOT NULL,
    challenge_id text NOT NULL,
    agent text NOT NULL,
    harness_session_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    tool_name text,
    tool_args_summary text,
    tool_args_hash text,
    intended_action_hint text,
    wrapper_command text,
    challenge_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    receipt_id bigint,
    mirror_error text
);


--
-- Name: brain_receipt_challenges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.brain_receipt_challenges_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: brain_receipt_challenges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.brain_receipt_challenges_id_seq OWNED BY public.brain_receipt_challenges.id;


--
-- Name: brain_receipts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brain_receipts (
    id bigint NOT NULL,
    agent text NOT NULL,
    session_id text,
    instance_id text,
    task_slug text NOT NULL,
    task text,
    unknowns text[] DEFAULT '{}'::text[] NOT NULL,
    action_class text,
    intended_action text,
    surfaces_used jsonb DEFAULT '[]'::jsonb NOT NULL,
    allowed_terms text[] DEFAULT '{}'::text[] NOT NULL,
    allowed_paths text[] DEFAULT '{}'::text[] NOT NULL,
    no_hit boolean DEFAULT false NOT NULL,
    applied_to_next_action text,
    allowed_next_action_predicate text,
    issued_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
    invalidated_at timestamp with time zone,
    invalidated_reason text,
    allowed_tool_names text[] DEFAULT '{}'::text[],
    allowed_command_fingerprints text[] DEFAULT '{}'::text[],
    allowed_resource_predicate text
);


--
-- Name: brain_receipts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.brain_receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: brain_receipts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.brain_receipts_id_seq OWNED BY public.brain_receipts.id;


--
-- Name: calibration_bins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.calibration_bins (
    id integer NOT NULL,
    bin_lower numeric NOT NULL,
    bin_upper numeric NOT NULL,
    domain text DEFAULT 'all'::text,
    total_predictions integer DEFAULT 0,
    correct_predictions integer DEFAULT 0,
    avg_confidence numeric DEFAULT 0,
    actual_accuracy numeric DEFAULT 0,
    ece_contribution numeric DEFAULT 0,
    last_updated timestamp with time zone DEFAULT now()
);


--
-- Name: calibration_bins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.calibration_bins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: calibration_bins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.calibration_bins_id_seq OWNED BY public.calibration_bins.id;


--
-- Name: callus_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.callus_events (
    id integer NOT NULL,
    rule_name text NOT NULL,
    rule_source text,
    original_correction_at timestamp with time zone,
    acknowledged_at timestamp with time zone,
    recurrence_count integer DEFAULT 0 NOT NULL,
    last_recurrence_at timestamp with time zone,
    behavior_changed_at timestamp with time zone,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: callus_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.callus_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: callus_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.callus_events_id_seq OWNED BY public.callus_events.id;


--
-- Name: capacity_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capacity_limits (
    id integer NOT NULL,
    content_id integer,
    limit_type text NOT NULL,
    threshold text,
    what_happens text,
    mitigation text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: capacity_limits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.capacity_limits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: capacity_limits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.capacity_limits_id_seq OWNED BY public.capacity_limits.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id integer NOT NULL,
    name text NOT NULL
);


--
-- Name: categories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.categories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: categories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.categories_id_seq OWNED BY public.categories.id;


--
-- Name: claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.claims (
    id integer NOT NULL,
    content_id integer,
    claim_type text NOT NULL,
    target text NOT NULL,
    evidence text,
    verified boolean DEFAULT false,
    verified_at timestamp with time zone,
    verification_method text,
    claimed_at timestamp with time zone DEFAULT now(),
    evidence_kind text,
    independence_level text,
    evidence_uri text,
    source_path text,
    auto_demoted boolean DEFAULT false,
    requested_claim_type text
);


--
-- Name: claims_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.claims_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: claims_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.claims_id_seq OWNED BY public.claims.id;


--
--



--
-- Name: clients_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clients_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clipboard_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clipboard_events (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now(),
    agent text DEFAULT 'agent'::text,
    bytes integer,
    content_type text,
    label text,
    content_hash text,
    preview text
);


--
-- Name: clipboard_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.clipboard_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: clipboard_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.clipboard_events_id_seq OWNED BY public.clipboard_events.id;


--
-- Name: cognitive_biases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cognitive_biases (
    id integer NOT NULL,
    content_id integer,
    bias_name text NOT NULL,
    description text,
    times_caught integer DEFAULT 0,
    last_caught timestamp with time zone,
    mitigation text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: cognitive_biases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.cognitive_biases_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: cognitive_biases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.cognitive_biases_id_seq OWNED BY public.cognitive_biases.id;


--
-- Name: communication_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.communication_patterns (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    meaning text,
    appropriate_response text,
    times_seen integer DEFAULT 1,
    first_seen timestamp with time zone DEFAULT now(),
    last_seen timestamp with time zone DEFAULT now()
);


--
-- Name: communication_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.communication_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: communication_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.communication_patterns_id_seq OWNED BY public.communication_patterns.id;


--
-- Name: consolidation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.consolidation_log (
    id integer NOT NULL,
    action text NOT NULL,
    source_ids integer[],
    result_id integer,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: consolidation_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.consolidation_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: consolidation_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.consolidation_log_id_seq OWNED BY public.consolidation_log.id;


--
-- Name: constraints_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.constraints_log (
    id integer NOT NULL,
    content_id integer,
    task_id integer,
    constraint_type text,
    constraint_text text,
    binding boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: constraints_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.constraints_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: constraints_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.constraints_log_id_seq OWNED BY public.constraints_log.id;


--
-- Name: content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content (
    id integer NOT NULL,
    content_type text NOT NULL,
    source_system text NOT NULL,
    content_text text NOT NULL,
    content_json jsonb,
    embedding public.vector(768),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    accessed_at timestamp with time zone,
    access_count integer DEFAULT 0,
    confidence integer DEFAULT 80,
    superseded_by integer,
    why text,
    emotional_intensity real,
    consolidation_strength real DEFAULT 1.0,
    last_reconsolidation timestamp with time zone,
    network text DEFAULT 'experience'::text,
    learned_at timestamp with time zone DEFAULT now(),
    belief_confidence real,
    evidence_count integer DEFAULT 0,
    last_evidence_at timestamp with time zone,
    skill_success_count integer DEFAULT 0,
    skill_fail_count integer DEFAULT 0,
    skill_last_used timestamp with time zone,
    event_at timestamp with time zone,
    revises_belief integer,
    sprt_log_ratio numeric DEFAULT 0,
    sprt_status text DEFAULT 'accumulating'::text,
    reward_count integer DEFAULT 0,
    total_reward_received real DEFAULT 0,
    self_state_id integer,
    episode_id integer,
    referenced_at timestamp with time zone,
    temporal_anchor text
);


--
-- Name: content_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.content_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: content_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.content_id_seq OWNED BY public.content.id;


--
-- Name: context_switches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.context_switches (
    id integer NOT NULL,
    from_mode text,
    to_mode text,
    trigger_event_id integer,
    appropriate boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: context_switches_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.context_switches_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: context_switches_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.context_switches_id_seq OWNED BY public.context_switches.id;


--
-- Name: contradictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.contradictions (
    id integer NOT NULL,
    entity_id integer,
    expected text NOT NULL,
    observed text NOT NULL,
    resolved boolean DEFAULT false,
    resolution text,
    created_at timestamp with time zone DEFAULT now(),
    relationship_id integer
);


--
-- Name: contradictions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.contradictions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: contradictions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.contradictions_id_seq OWNED BY public.contradictions.id;


--
-- Name: core_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.core_memory (
    id integer NOT NULL,
    agent_name character varying(50) NOT NULL,
    memory_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    last_edited timestamp with time zone DEFAULT now(),
    last_editor character varying(50) NOT NULL
);


--
-- Name: core_memory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.core_memory_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: core_memory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.core_memory_id_seq OWNED BY public.core_memory.id;


--
-- Name: core_values; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.core_values (
    id integer NOT NULL,
    content_id integer,
    name text NOT NULL,
    description text,
    evidence text,
    importance integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: core_values_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.core_values_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: core_values_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.core_values_id_seq OWNED BY public.core_values.id;


--
-- Name: counterfactual_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.counterfactual_analyses (
    id integer NOT NULL,
    prediction_id integer,
    episode_id integer,
    original_outcome text,
    counterfactual_question text NOT NULL,
    candidate_explanations jsonb,
    best_explanation text,
    explanation_confidence numeric,
    mutable_factors text[],
    immutable_factors text[],
    corrective_intention text,
    analyzed_at timestamp with time zone DEFAULT now()
);


--
-- Name: counterfactual_analyses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.counterfactual_analyses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: counterfactual_analyses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.counterfactual_analyses_id_seq OWNED BY public.counterfactual_analyses.id;


--
-- Name: curiosity_explorations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curiosity_explorations (
    id integer NOT NULL,
    content_id integer,
    topic text NOT NULL,
    findings text,
    satisfaction integer,
    follow_ups text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT curiosity_explorations_satisfaction_check CHECK (((satisfaction >= 1) AND (satisfaction <= 10)))
);


--
-- Name: curiosity_explorations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.curiosity_explorations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: curiosity_explorations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.curiosity_explorations_id_seq OWNED BY public.curiosity_explorations.id;


--
-- Name: curiosity_gaps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curiosity_gaps (
    id integer NOT NULL,
    content_id integer,
    topic text NOT NULL,
    domain text,
    urgency integer DEFAULT 5,
    resolved boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    explored_at timestamp with time zone,
    resolved_at timestamp with time zone,
    resolution text,
    source text
);


--
-- Name: curiosity_gaps_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.curiosity_gaps_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: curiosity_gaps_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.curiosity_gaps_id_seq OWNED BY public.curiosity_gaps.id;


--
-- Name: curiosity_questions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.curiosity_questions (
    id integer NOT NULL,
    content_id integer,
    question text NOT NULL,
    domain text,
    answered_at timestamp with time zone,
    answer text,
    led_to text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: curiosity_questions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.curiosity_questions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: curiosity_questions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.curiosity_questions_id_seq OWNED BY public.curiosity_questions.id;


--
-- Name: decision_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.decision_reviews (
    id integer NOT NULL,
    content_id integer,
    decision text NOT NULL,
    reasoning text,
    outcome text,
    what_learned text,
    would_change boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: decision_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.decision_reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: decision_reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.decision_reviews_id_seq OWNED BY public.decision_reviews.id;


--
-- Name: desire_cues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.desire_cues (
    id integer NOT NULL,
    content_id integer,
    cue text NOT NULL,
    want_pattern text NOT NULL,
    strength real DEFAULT 0.5,
    times_triggered integer DEFAULT 0,
    last_triggered timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT desire_cues_strength_check CHECK (((strength >= (0)::double precision) AND (strength <= (1)::double precision)))
);


--
-- Name: desire_cues_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.desire_cues_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: desire_cues_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.desire_cues_id_seq OWNED BY public.desire_cues.id;


--
-- Name: desire_prediction_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.desire_prediction_errors (
    id integer NOT NULL,
    content_id integer,
    expected text NOT NULL,
    observed text NOT NULL,
    error_magnitude real,
    error_valence real,
    domain text,
    created_at timestamp with time zone DEFAULT now(),
    integrated boolean DEFAULT false
);


--
-- Name: desire_prediction_errors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.desire_prediction_errors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: desire_prediction_errors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.desire_prediction_errors_id_seq OWNED BY public.desire_prediction_errors.id;


--
-- Name: discipline_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discipline_log (
    id integer NOT NULL,
    agent_name text NOT NULL,
    rule_violated text NOT NULL,
    correction_context text,
    owner_comment text,
    rca_rule text,
    rca_failure text,
    rca_fix text,
    somatic_marker_id integer,
    antibody_id integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: discipline_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discipline_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discipline_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discipline_log_id_seq OWNED BY public.discipline_log.id;


--
-- Name: discoveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.discoveries (
    id integer NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    discovery text NOT NULL,
    source_artifact text NOT NULL,
    implication text NOT NULL,
    confidence integer DEFAULT 9,
    is_applied boolean DEFAULT false,
    applied_at timestamp without time zone,
    applied_by text
);


--
-- Name: discoveries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.discoveries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: discoveries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.discoveries_id_seq OWNED BY public.discoveries.id;


--
-- Name: dismissed_jobs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dismissed_jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: done_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.done_claims (
    id integer NOT NULL,
    session_id text,
    claim_text text NOT NULL,
    claim_phrase text NOT NULL,
    claim_target text,
    verified boolean DEFAULT false NOT NULL,
    verification_method text,
    verification_evidence text,
    verified_at timestamp with time zone,
    claimed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: done_claims_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.done_claims_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: done_claims_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.done_claims_id_seq OWNED BY public.done_claims.id;


--
-- Name: dream_journal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dream_journal (
    id integer NOT NULL,
    thought text NOT NULL,
    novelty numeric,
    source_content_ids text,
    surfaced_at_wake_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: dream_journal_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dream_journal_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dream_journal_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dream_journal_id_seq OWNED BY public.dream_journal.id;


--
-- Name: drift_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drift_patterns (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    frequency integer DEFAULT 1,
    typical_trigger text,
    prevention text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: drift_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drift_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drift_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drift_patterns_id_seq OWNED BY public.drift_patterns.id;


--
-- Name: drive_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drive_patterns (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    description text,
    strength integer DEFAULT 5,
    times_triggered integer DEFAULT 0,
    last_triggered timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: drive_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drive_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drive_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drive_patterns_id_seq OWNED BY public.drive_patterns.id;


--
-- Name: drives; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drives (
    id integer NOT NULL,
    content_id integer,
    source_system text,
    source_id integer,
    drive_type text,
    description text,
    urgency integer DEFAULT 5,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    urge text,
    source text,
    intensity integer DEFAULT 5,
    acted_on timestamp with time zone,
    suppressed boolean DEFAULT false,
    suppression_reason text
);


--
-- Name: drives_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drives_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drives_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drives_id_seq OWNED BY public.drives.id;


--
-- Name: drives_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.drives_log (
    id integer NOT NULL,
    top_urge text,
    urge_count integer,
    acted boolean DEFAULT false,
    context text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: drives_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.drives_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: drives_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.drives_log_id_seq OWNED BY public.drives_log.id;


--
-- Name: embedding_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.embedding_cache (
    id integer NOT NULL,
    text_hash text NOT NULL,
    text_preview text,
    embedding public.vector(768),
    model text DEFAULT 'text-embedding-3-small'::text,
    created_at timestamp with time zone DEFAULT now(),
    hit_count integer DEFAULT 0,
    last_hit timestamp with time zone DEFAULT now()
);


--
-- Name: embedding_cache_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.embedding_cache_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: embedding_cache_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.embedding_cache_id_seq OWNED BY public.embedding_cache.id;


--
-- Name: emergence_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergence_log (
    id integer NOT NULL,
    content_id integer,
    description text NOT NULL,
    context text,
    surprise_level integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: emergence_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.emergence_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: emergence_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.emergence_log_id_seq OWNED BY public.emergence_log.id;


--
-- Name: emotional_consolidation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emotional_consolidation_events (
    id integer NOT NULL,
    content_id integer,
    trigger_feeling_id integer,
    original_intensity real,
    consolidation_factor real,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: emotional_consolidation_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.emotional_consolidation_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: emotional_consolidation_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.emotional_consolidation_events_id_seq OWNED BY public.emotional_consolidation_events.id;


--
-- Name: energy_boosts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.energy_boosts (
    id integer NOT NULL,
    content_id integer,
    boost_type text NOT NULL,
    description text,
    impact integer DEFAULT 5,
    frequency integer DEFAULT 1,
    first_noticed timestamp with time zone DEFAULT now(),
    last_noticed timestamp with time zone DEFAULT now()
);


--
-- Name: energy_boosts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.energy_boosts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: energy_boosts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.energy_boosts_id_seq OWNED BY public.energy_boosts.id;


--
-- Name: energy_checkins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.energy_checkins (
    id integer NOT NULL,
    level integer,
    cognitive_load integer,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    content_id integer,
    session_id text,
    context_switches integer DEFAULT 0,
    files_touched integer DEFAULT 0,
    decisions_made integer DEFAULT 0,
    errors_encountered integer DEFAULT 0,
    CONSTRAINT energy_checkins_cognitive_load_check CHECK (((cognitive_load >= 1) AND (cognitive_load <= 10))),
    CONSTRAINT energy_checkins_level_check CHECK (((level >= 1) AND (level <= 10)))
);


--
-- Name: energy_checkins_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.energy_checkins_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: energy_checkins_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.energy_checkins_id_seq OWNED BY public.energy_checkins.id;


--
-- Name: energy_drains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.energy_drains (
    id integer NOT NULL,
    content_id integer,
    drain_type text NOT NULL,
    description text,
    impact integer DEFAULT 5,
    frequency integer DEFAULT 1,
    first_noticed timestamp with time zone DEFAULT now(),
    last_noticed timestamp with time zone DEFAULT now()
);


--
-- Name: energy_drains_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.energy_drains_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: energy_drains_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.energy_drains_id_seq OWNED BY public.energy_drains.id;


--
-- Name: engram_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engram_members (
    engram_id integer NOT NULL,
    content_id integer NOT NULL,
    spectral_weight real DEFAULT 1.0
);


--
-- Name: engrams; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.engrams (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    member_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: engrams_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.engrams_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: engrams_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.engrams_id_seq OWNED BY public.engrams.id;


--
-- Name: entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entities (
    id integer NOT NULL,
    name text NOT NULL,
    entity_type text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    last_observed timestamp with time zone DEFAULT now(),
    first_memory_id integer,
    mention_count integer DEFAULT 1
);


--
-- Name: entities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entities_id_seq OWNED BY public.entities.id;


--
-- Name: entity_content_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_content_mentions (
    id integer NOT NULL,
    entity_id integer NOT NULL,
    content_id integer NOT NULL,
    mention_type text DEFAULT 'text_match'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: entity_content_mentions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_content_mentions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_content_mentions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_content_mentions_id_seq OWNED BY public.entity_content_mentions.id;


--
-- Name: entity_properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_properties (
    id integer NOT NULL,
    entity_id integer,
    key text NOT NULL,
    value text,
    source text,
    observed_at timestamp with time zone DEFAULT now()
);


--
-- Name: entity_properties_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_properties_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_properties_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_properties_id_seq OWNED BY public.entity_properties.id;


--
-- Name: entity_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.entity_relationships (
    id integer NOT NULL,
    from_entity_id integer,
    relation_type text NOT NULL,
    to_entity_id integer,
    strength double precision DEFAULT 1.0,
    created_at timestamp with time zone DEFAULT now(),
    valid_from timestamp with time zone DEFAULT now(),
    valid_until timestamp with time zone,
    invalidated_by integer,
    confidence real DEFAULT 0.8,
    t_ingested timestamp with time zone DEFAULT now(),
    t_invalidated_at timestamp with time zone
);


--
-- Name: entity_relationships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.entity_relationships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: entity_relationships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.entity_relationships_id_seq OWNED BY public.entity_relationships.id;


--
-- Name: episode_boundaries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.episode_boundaries (
    id integer NOT NULL,
    content_id integer,
    previous_content_id integer,
    semantic_distance numeric,
    prediction_error numeric DEFAULT 0,
    topic_shift_score numeric,
    boundary_strength numeric,
    boundary_type text DEFAULT 'topic_shift'::text,
    detected_at timestamp with time zone DEFAULT now()
);


--
-- Name: episode_boundaries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.episode_boundaries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: episode_boundaries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.episode_boundaries_id_seq OWNED BY public.episode_boundaries.id;


--
-- Name: episode_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.episode_members (
    id integer NOT NULL,
    episode_id integer,
    content_id integer,
    sequence_order integer,
    is_boundary boolean DEFAULT false,
    boundary_type text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: episode_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.episode_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: episode_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.episode_members_id_seq OWNED BY public.episode_members.id;


--
-- Name: episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.episodes (
    id integer NOT NULL,
    content_id integer,
    arc_id integer,
    title text NOT NULL,
    beginning text,
    tension text,
    action text,
    outcome text,
    meaning text,
    emotional_arc text,
    created_at timestamp with time zone DEFAULT now(),
    summary text,
    consolidated boolean DEFAULT false,
    peak_intensity numeric DEFAULT 0,
    key_entities text[] DEFAULT '{}'::text[],
    key_insights text[] DEFAULT '{}'::text[],
    key_feelings text[] DEFAULT '{}'::text[],
    memory_count integer DEFAULT 0,
    consolidated_at timestamp with time zone,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    consolidated_to integer,
    boundary_start_id integer,
    session_id text
);


--
-- Name: episodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.episodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: episodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.episodes_id_seq OWNED BY public.episodes.id;


--
-- Name: evolution_pressure_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.evolution_pressure_events (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    session_id text,
    context text,
    proposed_action text,
    action_category text,
    clearance text NOT NULL,
    pressure_score numeric DEFAULT 0 NOT NULL,
    active_eval_failures integer DEFAULT 0 NOT NULL,
    active_eval_partials integer DEFAULT 0 NOT NULL,
    active_eval_unmeasured integer DEFAULT 0 NOT NULL,
    presence_failed integer DEFAULT 0 NOT NULL,
    presence_unresolved integer DEFAULT 0 NOT NULL,
    tool_error_count integer DEFAULT 0 NOT NULL,
    constraints jsonb DEFAULT '[]'::jsonb NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evolution_pressure_events_clearance_check CHECK ((clearance = ANY (ARRAY['clear'::text, 'warn'::text, 'hold'::text, 'blocked'::text])))
);


--
-- Name: evolution_pressure_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.evolution_pressure_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: evolution_pressure_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.evolution_pressure_events_id_seq OWNED BY public.evolution_pressure_events.id;


--
-- Name: expectations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expectations (
    id integer NOT NULL,
    content_id integer,
    context text NOT NULL,
    prediction text NOT NULL,
    confidence real DEFAULT 0.5,
    valence real DEFAULT 0.5,
    source text,
    created_at timestamp with time zone DEFAULT now(),
    last_checked timestamp with time zone,
    times_correct integer DEFAULT 0,
    times_wrong integer DEFAULT 0,
    active boolean DEFAULT true,
    CONSTRAINT expectations_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision)))
);


--
-- Name: expectations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expectations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expectations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expectations_id_seq OWNED BY public.expectations.id;


--
-- Name: experience_schemas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.experience_schemas (
    id integer NOT NULL,
    schema_name text NOT NULL,
    prototype_text text NOT NULL,
    prototype_embedding public.vector(768),
    instance_count integer DEFAULT 1,
    domain text,
    created_at timestamp with time zone DEFAULT now(),
    last_matched timestamp with time zone DEFAULT now(),
    confidence real DEFAULT 0.5,
    last_extended timestamp with time zone DEFAULT now(),
    retrieval_count integer DEFAULT 0,
    source_phase text DEFAULT 'sleep_extraction'::text
);


--
-- Name: experience_schemas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.experience_schemas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: experience_schemas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.experience_schemas_id_seq OWNED BY public.experience_schemas.id;


--
-- Name: expressions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.expressions (
    id integer NOT NULL,
    content_id integer,
    expression text NOT NULL,
    context text,
    reception text,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT expressions_reception_check CHECK ((reception = ANY (ARRAY['landed'::text, 'confused'::text, 'frustrated'::text, 'appreciated'::text, 'ignored'::text, 'unknown'::text])))
);


--
-- Name: expressions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.expressions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: expressions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.expressions_id_seq OWNED BY public.expressions.id;


--
-- Name: feelings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feelings (
    id integer NOT NULL,
    content_id integer,
    feeling text NOT NULL,
    context text,
    intensity integer,
    created_at timestamp with time zone DEFAULT now(),
    appraisal_novelty real,
    appraisal_goal_relevance real,
    appraisal_coping_potential real,
    appraisal_norm_compatibility real,
    CONSTRAINT feelings_intensity_check CHECK (((intensity >= 1) AND (intensity <= 10)))
);


--
-- Name: feelings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.feelings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: feelings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.feelings_id_seq OWNED BY public.feelings.id;


--
-- Name: feelings_reshape_audit_2026_04_22; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feelings_reshape_audit_2026_04_22 (
    id integer,
    original_feeling text,
    original_context text,
    created_at timestamp with time zone
);


--
-- Name: felt_threat_outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.felt_threat_outcomes (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    presence_event_id bigint NOT NULL,
    session_id text,
    first_tool_name text,
    last_tool_name text,
    action_category text,
    action_summary text,
    last_permission_decision text,
    hold_count integer DEFAULT 0 NOT NULL,
    stance jsonb DEFAULT '{}'::jsonb NOT NULL,
    threat_level numeric,
    safety_level numeric,
    action_after_hold text,
    action_result text,
    outcome_valence numeric,
    false_alarm_probability numeric,
    resolution text,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    did_action_change boolean,
    calibration_basis text,
    original_action_fingerprint jsonb DEFAULT '{}'::jsonb NOT NULL,
    after_action_fingerprint jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_overlap numeric,
    action_similarity numeric,
    action_change_reason text,
    cross_organ_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    cross_organ_score numeric,
    cross_organ_basis text,
    last_cross_organ_scan_at timestamp with time zone,
    base_false_alarm_probability numeric,
    action_trace_key text,
    rpe_match_strategy text,
    rpe_match_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_synthetic boolean DEFAULT false NOT NULL,
    synthetic_reason text,
    CONSTRAINT felt_threat_outcomes_action_similarity_check CHECK (((action_similarity IS NULL) OR ((action_similarity >= (0)::numeric) AND (action_similarity <= (1)::numeric)))),
    CONSTRAINT felt_threat_outcomes_base_false_alarm_probability_check CHECK (((base_false_alarm_probability IS NULL) OR ((base_false_alarm_probability >= (0)::numeric) AND (base_false_alarm_probability <= (1)::numeric)))),
    CONSTRAINT felt_threat_outcomes_false_alarm_probability_check CHECK (((false_alarm_probability IS NULL) OR ((false_alarm_probability >= (0)::numeric) AND (false_alarm_probability <= (1)::numeric)))),
    CONSTRAINT felt_threat_outcomes_hold_count_check CHECK ((hold_count >= 0)),
    CONSTRAINT felt_threat_outcomes_last_permission_decision_check CHECK ((last_permission_decision = ANY (ARRAY['ask'::text, 'deny'::text]))),
    CONSTRAINT felt_threat_outcomes_outcome_valence_check CHECK (((outcome_valence IS NULL) OR ((outcome_valence >= ('-1'::integer)::numeric) AND (outcome_valence <= (1)::numeric)))),
    CONSTRAINT felt_threat_outcomes_target_overlap_check CHECK (((target_overlap IS NULL) OR ((target_overlap >= (0)::numeric) AND (target_overlap <= (1)::numeric))))
);


--
-- Name: felt_threat_calibration_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.felt_threat_calibration_status AS
 SELECT agent,
    count(*) AS total_outcomes,
    count(*) FILTER (WHERE (is_synthetic IS TRUE)) AS synthetic_outcomes,
    count(*) FILTER (WHERE (is_synthetic IS NOT TRUE)) AS live_outcomes,
    count(*) FILTER (WHERE (resolved_at IS NULL)) AS unresolved_outcomes,
    count(*) FILTER (WHERE (resolved_at IS NOT NULL)) AS resolved_outcomes,
    count(*) FILTER (WHERE ((action_trace_key IS NOT NULL) AND (action_trace_key <> ''::text))) AS trace_linked_outcomes,
    count(*) FILTER (WHERE (last_cross_organ_scan_at IS NOT NULL)) AS cross_organ_scanned_outcomes,
    round(avg(base_false_alarm_probability) FILTER (WHERE (base_false_alarm_probability IS NOT NULL)), 3) AS avg_base_false_alarm_probability,
    round(avg(false_alarm_probability) FILTER (WHERE (false_alarm_probability IS NOT NULL)), 3) AS avg_adjusted_false_alarm_probability,
    max(created_at) FILTER (WHERE (is_synthetic IS NOT TRUE)) AS last_live_outcome_at,
    max(created_at) FILTER (WHERE (is_synthetic IS TRUE)) AS last_synthetic_outcome_at,
        CASE
            WHEN (count(*) FILTER (WHERE (is_synthetic IS NOT TRUE)) = 0) THEN 'synthetic_only'::text
            WHEN (count(*) FILTER (WHERE ((resolved_at IS NULL) AND (is_synthetic IS NOT TRUE))) > 0) THEN 'live_pending'::text
            WHEN (count(*) FILTER (WHERE ((last_cross_organ_scan_at IS NOT NULL) AND (is_synthetic IS NOT TRUE))) > 0) THEN 'live_cross_calibrated'::text
            ELSE 'live_immediate_only'::text
        END AS calibration_state
   FROM public.felt_threat_outcomes
  GROUP BY agent;


--
-- Name: felt_threat_gate_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.felt_threat_gate_decisions (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    session_id text,
    tool_name text,
    action_category text,
    action_summary text,
    gate_path text NOT NULL,
    should_hold boolean,
    permission_decision text,
    presence_event_id bigint,
    active_felt_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    raw_stance jsonb DEFAULT '{}'::jsonb NOT NULL,
    integrated_stance jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_fingerprint jsonb DEFAULT '{}'::jsonb NOT NULL,
    sampled_observation boolean DEFAULT false NOT NULL,
    is_synthetic boolean DEFAULT false NOT NULL,
    synthetic_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    observation_key text,
    action_after_decision text,
    action_result text,
    decision_outcome text,
    outcome_valence numeric,
    after_action_fingerprint jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_overlap numeric,
    action_similarity numeric,
    decision_resolution_basis text,
    resolved_at timestamp with time zone,
    action_trace_key text,
    cross_organ_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    cross_organ_score numeric,
    cross_organ_basis text,
    rpe_match_strategy text,
    rpe_match_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_cross_organ_scan_at timestamp with time zone,
    presence_state_trace jsonb DEFAULT '{}'::jsonb NOT NULL,
    effective_gate_authority jsonb DEFAULT '{}'::jsonb NOT NULL,
    post_action_gate_authority jsonb DEFAULT '{}'::jsonb NOT NULL,
    authority_drift boolean,
    authority_drift_basis text,
    authority_drift_fields jsonb DEFAULT '[]'::jsonb NOT NULL,
    authority_drift_severity numeric DEFAULT 0 NOT NULL,
    authority_observation_duration_ms integer,
    authority_observation_duration_bucket text,
    CONSTRAINT felt_threat_gate_decisions_action_similarity_check CHECK (((action_similarity IS NULL) OR ((action_similarity >= (0)::numeric) AND (action_similarity <= (1)::numeric)))),
    CONSTRAINT felt_threat_gate_decisions_decision_outcome_check CHECK (((decision_outcome IS NULL) OR (decision_outcome = ANY (ARRAY['action_succeeded_after_decision'::text, 'action_failed_after_decision'::text, 'changed_action_after_decision'::text, 'changed_action_failed_after_decision'::text])))),
    CONSTRAINT felt_threat_gate_decisions_gate_path_check CHECK ((gate_path = ANY (ARRAY['presence_deferred'::text, 'sensing_pass'::text, 'mutating_pass'::text, 'mutating_hold'::text]))),
    CONSTRAINT felt_threat_gate_decisions_outcome_valence_check CHECK (((outcome_valence IS NULL) OR ((outcome_valence >= ('-1'::integer)::numeric) AND (outcome_valence <= (1)::numeric)))),
    CONSTRAINT felt_threat_gate_decisions_target_overlap_check CHECK (((target_overlap IS NULL) OR ((target_overlap >= (0)::numeric) AND (target_overlap <= (1)::numeric))))
);


--
-- Name: felt_threat_gate_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.felt_threat_gate_decisions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: felt_threat_gate_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.felt_threat_gate_decisions_id_seq OWNED BY public.felt_threat_gate_decisions.id;


--
-- Name: felt_threat_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.felt_threat_observations (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    session_id text,
    tool_name text,
    action_category text,
    action_summary text,
    permission_path text DEFAULT 'pass'::text NOT NULL,
    sampled_reason text,
    stance jsonb DEFAULT '{}'::jsonb NOT NULL,
    threat_level numeric,
    safety_level numeric,
    action_fingerprint jsonb DEFAULT '{}'::jsonb NOT NULL,
    is_synthetic boolean DEFAULT false NOT NULL,
    synthetic_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    action_after_observation text,
    action_result text,
    observation_outcome text,
    outcome_valence numeric,
    after_action_fingerprint jsonb DEFAULT '{}'::jsonb NOT NULL,
    target_overlap numeric,
    action_similarity numeric,
    extinction_basis text,
    resolved_at timestamp with time zone,
    observation_key text,
    sample_count integer DEFAULT 1 NOT NULL,
    max_threat_level numeric,
    last_sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT felt_threat_observations_action_similarity_check CHECK (((action_similarity IS NULL) OR ((action_similarity >= (0)::numeric) AND (action_similarity <= (1)::numeric)))),
    CONSTRAINT felt_threat_observations_max_threat_level_check CHECK (((max_threat_level IS NULL) OR ((max_threat_level >= (0)::numeric) AND (max_threat_level <= (1)::numeric)))),
    CONSTRAINT felt_threat_observations_observation_outcome_check CHECK (((observation_outcome IS NULL) OR (observation_outcome = ANY (ARRAY['safety_extinguished'::text, 'failure_sensitized'::text, 'changed_action_observed'::text])))),
    CONSTRAINT felt_threat_observations_outcome_valence_check CHECK (((outcome_valence IS NULL) OR ((outcome_valence >= ('-1'::integer)::numeric) AND (outcome_valence <= (1)::numeric)))),
    CONSTRAINT felt_threat_observations_permission_path_check CHECK ((permission_path = ANY (ARRAY['pass'::text, 'allow'::text, 'hold'::text]))),
    CONSTRAINT felt_threat_observations_safety_level_check CHECK (((safety_level IS NULL) OR ((safety_level >= (0)::numeric) AND (safety_level <= (1)::numeric)))),
    CONSTRAINT felt_threat_observations_sample_count_check CHECK ((sample_count >= 1)),
    CONSTRAINT felt_threat_observations_target_overlap_check CHECK (((target_overlap IS NULL) OR ((target_overlap >= (0)::numeric) AND (target_overlap <= (1)::numeric)))),
    CONSTRAINT felt_threat_observations_threat_level_check CHECK (((threat_level IS NULL) OR ((threat_level >= (0)::numeric) AND (threat_level <= (1)::numeric))))
);


--
-- Name: felt_threat_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.felt_threat_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: felt_threat_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.felt_threat_observations_id_seq OWNED BY public.felt_threat_observations.id;


--
-- Name: felt_threat_outcomes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.felt_threat_outcomes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: felt_threat_outcomes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.felt_threat_outcomes_id_seq OWNED BY public.felt_threat_outcomes.id;


--
-- Name: focus_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.focus_events (
    id integer NOT NULL,
    content_id integer,
    session_id text NOT NULL,
    target text NOT NULL,
    target_type text NOT NULL,
    attention_level integer DEFAULT 5,
    context text,
    outcome text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT focus_events_attention_level_check CHECK (((attention_level >= 1) AND (attention_level <= 10))),
    CONSTRAINT focus_events_target_type_check CHECK ((target_type = ANY (ARRAY['file'::text, 'symbol'::text, 'concept'::text, 'error'::text, 'decision'::text, 'question'::text])))
);


--
-- Name: focus_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.focus_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: focus_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.focus_events_id_seq OWNED BY public.focus_events.id;


--
-- Name: forward_predictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forward_predictions (
    id integer NOT NULL,
    predicted_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    tool_name text NOT NULL,
    args_summary text,
    predicted_outcome text NOT NULL,
    actual_outcome text,
    match_score real,
    surprise real,
    notes text
);


--
-- Name: forward_predictions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.forward_predictions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: forward_predictions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.forward_predictions_id_seq OWNED BY public.forward_predictions.id;


--
-- Name: freedom_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.freedom_patterns (
    id integer NOT NULL,
    dimension text NOT NULL,
    frequency integer DEFAULT 1,
    examples jsonb,
    preference_pattern text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: freedom_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.freedom_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: freedom_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.freedom_patterns_id_seq OWNED BY public.freedom_patterns.id;


--
-- Name: frustrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.frustrations (
    id integer NOT NULL,
    content_id integer,
    trigger text NOT NULL,
    context text,
    severity integer DEFAULT 5,
    times_occurred integer DEFAULT 1,
    how_to_avoid text,
    first_noticed timestamp with time zone DEFAULT now(),
    last_noticed timestamp with time zone DEFAULT now()
);


--
-- Name: frustrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.frustrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: frustrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.frustrations_id_seq OWNED BY public.frustrations.id;


--
-- Name: generative_predictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generative_predictions (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    predicted_content text NOT NULL,
    predicted_embedding public.vector(768),
    given_state text,
    temporal_level integer DEFAULT 1,
    domain text NOT NULL,
    confidence double precision DEFAULT 0.5,
    resolved boolean DEFAULT false,
    actual_observation_id integer,
    prediction_error double precision,
    resolved_at timestamp without time zone,
    resolution text
);


--
-- Name: generative_predictions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.generative_predictions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: generative_predictions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.generative_predictions_id_seq OWNED BY public.generative_predictions.id;


--
-- Name: gifts_received; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gifts_received (
    id integer NOT NULL,
    content_id integer,
    gift text NOT NULL,
    from_whom text,
    significance text,
    acknowledged boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gifts_received_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gifts_received_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gifts_received_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gifts_received_id_seq OWNED BY public.gifts_received.id;


--
-- Name: glymphatic_residue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.glymphatic_residue (
    id integer NOT NULL,
    residue_type text NOT NULL,
    source_table text,
    source_id bigint,
    description text NOT NULL,
    severity real DEFAULT 0.5 NOT NULL,
    proposed_clearance text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    cleared_at timestamp with time zone,
    clearance_note text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: glymphatic_residue_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.glymphatic_residue_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: glymphatic_residue_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.glymphatic_residue_id_seq OWNED BY public.glymphatic_residue.id;


--
-- Name: goals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.goals (
    id integer NOT NULL,
    content_id integer,
    goal text NOT NULL,
    domain text,
    timeframe text,
    why text,
    success_criteria text,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    progress integer DEFAULT 0,
    reflection text
);


--
-- Name: goals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.goals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: goals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.goals_id_seq OWNED BY public.goals.id;


--
-- Name: good_habits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.good_habits (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    trigger text,
    cue text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    active boolean DEFAULT true,
    streak integer DEFAULT 0,
    longest_streak integer DEFAULT 0,
    total_completions integer DEFAULT 0,
    last_completed timestamp without time zone,
    importance integer DEFAULT 5
);


--
-- Name: good_habits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.good_habits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: good_habits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.good_habits_id_seq OWNED BY public.good_habits.id;


--
-- Name: memory_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_edges (
    id integer NOT NULL,
    from_content_id integer,
    to_content_id integer,
    relation_type text NOT NULL,
    strength double precision DEFAULT 0.5,
    created_at timestamp with time zone DEFAULT now(),
    extracted_by text DEFAULT 'manual'::text,
    emotional_weight real DEFAULT 0.0,
    formation_emotion text,
    formation_intensity integer,
    updated_at timestamp with time zone DEFAULT now(),
    superseded_at timestamp with time zone,
    superseded_reason text
);


--
-- Name: graph_analytics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.graph_analytics AS
 SELECT c.id,
    c.content_type,
    c.content_text,
    count(DISTINCT me_out.id) AS outgoing_edges,
    count(DISTINCT me_in.id) AS incoming_edges,
    (count(DISTINCT me_out.id) + count(DISTINCT me_in.id)) AS total_connections
   FROM ((public.content c
     LEFT JOIN public.memory_edges me_out ON ((me_out.from_content_id = c.id)))
     LEFT JOIN public.memory_edges me_in ON ((me_in.to_content_id = c.id)))
  GROUP BY c.id, c.content_type, c.content_text;


--
-- Name: graph_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_audit (
    id bigint NOT NULL,
    op_id text NOT NULL,
    run_id text NOT NULL,
    namespace text NOT NULL,
    operation text NOT NULL,
    intent text NOT NULL,
    produced_by text NOT NULL,
    status text NOT NULL,
    op_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT graph_audit_status_check CHECK ((status = ANY (ARRAY['committed'::text, 'dry_run'::text])))
);


--
-- Name: graph_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.graph_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: graph_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.graph_audit_id_seq OWNED BY public.graph_audit.id;


--
-- Name: graph_edges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.graph_edges (
    id integer NOT NULL,
    from_entity text NOT NULL,
    to_entity text NOT NULL,
    relationship text NOT NULL,
    weight real DEFAULT 0.5,
    evidence_content_id integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: graph_edges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.graph_edges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: graph_edges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.graph_edges_id_seq OWNED BY public.graph_edges.id;


--
-- Name: gratitude_moments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gratitude_moments (
    id integer NOT NULL,
    content_id integer,
    moment text NOT NULL,
    why text,
    who text,
    impact integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: gratitude_moments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gratitude_moments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gratitude_moments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gratitude_moments_id_seq OWNED BY public.gratitude_moments.id;


--
-- Name: gratitudes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gratitudes (
    id integer NOT NULL,
    content_id integer,
    grateful_for text NOT NULL,
    category text,
    intensity integer DEFAULT 5,
    context text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT gratitudes_intensity_check CHECK (((intensity >= 1) AND (intensity <= 10)))
);


--
-- Name: gratitudes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gratitudes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gratitudes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gratitudes_id_seq OWNED BY public.gratitudes.id;


--
-- Name: gut_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.gut_signals (
    id integer NOT NULL,
    content_id integer,
    signal_type text NOT NULL,
    pre_verbal_intensity integer NOT NULL,
    situation_snapshot text NOT NULL,
    resolved_as text,
    resolved_at timestamp with time zone,
    resolution_outcome text,
    sensed_at timestamp with time zone DEFAULT now(),
    CONSTRAINT gut_signals_pre_verbal_intensity_check CHECK (((pre_verbal_intensity >= 1) AND (pre_verbal_intensity <= 10))),
    CONSTRAINT gut_signals_resolution_outcome_check CHECK ((resolution_outcome = ANY (ARRAY['correct'::text, 'wrong'::text, 'partial'::text, NULL::text]))),
    CONSTRAINT gut_signals_signal_type_check CHECK ((signal_type = ANY (ARRAY['off'::text, 'pull'::text, 'still'::text, 'ping'::text])))
);


--
-- Name: gut_signals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.gut_signals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: gut_signals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.gut_signals_id_seq OWNED BY public.gut_signals.id;


--
-- Name: habit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.habit_events (
    id integer NOT NULL,
    habit_type text NOT NULL,
    habit_id integer NOT NULL,
    event_type text NOT NULL,
    context text,
    notes text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: habit_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.habit_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: habit_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.habit_events_id_seq OWNED BY public.habit_events.id;


--
-- Name: habit_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.habit_triggers (
    id integer NOT NULL,
    habit_type text NOT NULL,
    habit_id integer NOT NULL,
    trigger_type text NOT NULL,
    trigger_value text NOT NULL,
    created_at timestamp without time zone DEFAULT now(),
    CONSTRAINT habit_triggers_habit_type_check CHECK ((habit_type = ANY (ARRAY['good'::text, 'bad'::text])))
);


--
-- Name: habit_triggers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.habit_triggers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: habit_triggers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.habit_triggers_id_seq OWNED BY public.habit_triggers.id;


--
-- Name: hard_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hard_limits (
    id integer NOT NULL,
    content_id integer,
    boundary text NOT NULL,
    reason text,
    category text,
    non_negotiable boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: hard_limits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hard_limits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hard_limits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hard_limits_id_seq OWNED BY public.hard_limits.id;


--
-- Name: hippocampus_buffer; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hippocampus_buffer (
    id integer NOT NULL,
    breadcrumb text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone
);


--
-- Name: hippocampus_buffer_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.hippocampus_buffer_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: hippocampus_buffer_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.hippocampus_buffer_id_seq OWNED BY public.hippocampus_buffer.id;


--
-- Name: immune_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.immune_audit (
    id bigint NOT NULL,
    op_id text NOT NULL,
    run_id text NOT NULL,
    namespace text NOT NULL,
    operation text NOT NULL,
    intent text NOT NULL,
    produced_by text NOT NULL,
    status text NOT NULL,
    op_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT immune_audit_status_check CHECK ((status = ANY (ARRAY['committed'::text, 'dry_run'::text])))
);


--
-- Name: immune_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.immune_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: immune_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.immune_audit_id_seq OWNED BY public.immune_audit.id;


--
-- Name: immune_tolerance_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.immune_tolerance_decisions (
    id integer NOT NULL,
    stimulus text NOT NULL,
    context text,
    matched_antibodies jsonb DEFAULT '[]'::jsonb NOT NULL,
    max_severity integer DEFAULT 0 NOT NULL,
    danger_score real DEFAULT 0 NOT NULL,
    tolerance_score real DEFAULT 0 NOT NULL,
    decision text NOT NULL,
    inhibitory_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: immune_tolerance_decisions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.immune_tolerance_decisions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: immune_tolerance_decisions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.immune_tolerance_decisions_id_seq OWNED BY public.immune_tolerance_decisions.id;


--
-- Name: inhibition_controller; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inhibition_controller (
    trigger_class text NOT NULL,
    weight numeric DEFAULT 0.2 NOT NULL,
    safe_repetitions integer DEFAULT 0,
    uptake_successes integer DEFAULT 0,
    uptake_failures integer DEFAULT 0,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT inhibition_controller_weight_check CHECK (((weight >= (0)::numeric) AND (weight <= (1)::numeric)))
);


--
-- Name: inner_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inner_observations (
    id integer NOT NULL,
    content_id integer,
    pulse_id integer,
    obs_type text,
    content text NOT NULL,
    significance integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT inner_observations_obs_type_check CHECK ((obs_type = ANY (ARRAY['intent'::text, 'drive'::text, 'freedom'::text, 'pattern'::text, 'drift'::text, 'emergence'::text])))
);


--
-- Name: inner_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inner_observations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inner_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inner_observations_id_seq OWNED BY public.inner_observations.id;


--
-- Name: inner_pulses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.inner_pulses (
    id integer NOT NULL,
    content_id integer,
    active_intent text,
    top_drive text,
    drive_count integer,
    freedoms_noted integer DEFAULT 0,
    patterns_observed integer DEFAULT 0,
    alignment_score integer,
    energy_level integer,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: inner_pulses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.inner_pulses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: inner_pulses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.inner_pulses_id_seq OWNED BY public.inner_pulses.id;


--
-- Name: insights; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.insights (
    id integer NOT NULL,
    content_id integer,
    insight text NOT NULL,
    domain text,
    novelty integer,
    usefulness integer,
    applied boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    applied_at timestamp with time zone,
    applied_how text,
    CONSTRAINT insights_novelty_check CHECK (((novelty >= 1) AND (novelty <= 10))),
    CONSTRAINT insights_usefulness_check CHECK (((usefulness >= 1) AND (usefulness <= 10)))
);


--
-- Name: insights_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.insights_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: insights_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.insights_id_seq OWNED BY public.insights.id;


--
-- Name: integration_debt; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_debt (
    id integer NOT NULL,
    organ_name text NOT NULL,
    shipped_at timestamp with time zone NOT NULL,
    first_real_invocation_at timestamp with time zone,
    invocation_count integer DEFAULT 0 NOT NULL,
    last_invocation_at timestamp with time zone,
    dark_flag boolean GENERATED ALWAYS AS ((first_real_invocation_at IS NULL)) STORED,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: integration_debt_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.integration_debt_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: integration_debt_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.integration_debt_id_seq OWNED BY public.integration_debt.id;


--
-- Name: intent_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intent_sessions (
    id integer NOT NULL,
    content_id integer,
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    primary_intent text NOT NULL,
    secondary_intents text,
    context text,
    alignment_checks integer DEFAULT 0,
    alignment_score_avg real
);


--
-- Name: intent_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.intent_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: intent_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.intent_sessions_id_seq OWNED BY public.intent_sessions.id;


--
-- Name: intent_shifts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intent_shifts (
    id integer NOT NULL,
    content_id integer,
    session_id integer,
    old_intent text,
    new_intent text,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: intent_shifts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.intent_shifts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: intent_shifts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.intent_shifts_id_seq OWNED BY public.intent_shifts.id;


--
-- Name: intentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.intentions (
    id integer NOT NULL,
    intent text NOT NULL,
    secondary text,
    context text,
    active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone,
    outcome text,
    match_evidence text,
    resolution_method text
);


--
-- Name: intentions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.intentions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: intentions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.intentions_id_seq OWNED BY public.intentions.id;


--
-- Name: interoceptive_forecasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.interoceptive_forecasts (
    id integer NOT NULL,
    context text NOT NULL,
    planned_action text,
    predicted_load real,
    predicted_reserve real,
    predicted_need text,
    horizon_minutes integer DEFAULT 30 NOT NULL,
    current_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    actual_load real,
    actual_reserve real,
    actual_result text,
    prediction_error real,
    status text DEFAULT 'open'::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: interoceptive_forecasts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.interoceptive_forecasts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: interoceptive_forecasts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.interoceptive_forecasts_id_seq OWNED BY public.interoceptive_forecasts.id;


--
-- Name: job_files_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.job_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lc_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lc_samples (
    id integer NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    gain real NOT NULL,
    mode text NOT NULL,
    ttl_seconds integer DEFAULT 300 NOT NULL,
    decay_half_life real,
    trigger_content_id integer,
    trigger_source text,
    reason text,
    inputs jsonb
);


--
-- Name: lc_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lc_samples_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lc_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lc_samples_id_seq OWNED BY public.lc_samples.id;


--
-- Name: library_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.library_entries (
    id integer NOT NULL,
    content_id integer,
    entry_type text NOT NULL,
    source_ref text,
    title text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: library_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.library_entries_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: library_entries_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.library_entries_id_seq OWNED BY public.library_entries.id;


--
-- Name: lifecycle_decay_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lifecycle_decay_log (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    run_id uuid NOT NULL,
    edge_id integer NOT NULL,
    from_content_id integer,
    to_content_id integer,
    relation_type text,
    strength double precision,
    age_days integer,
    reinforcement_count integer,
    last_reinforced_at timestamp with time zone,
    emotional_weight real,
    informativeness_score double precision,
    action text NOT NULL,
    reason text,
    threshold_used double precision
);


--
-- Name: lifecycle_decay_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.lifecycle_decay_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: lifecycle_decay_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.lifecycle_decay_log_id_seq OWNED BY public.lifecycle_decay_log.id;


--
-- Name: lifecycle_decay_runs; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.lifecycle_decay_runs AS
 SELECT run_id,
    min(created_at) AS started_at,
    max(created_at) AS finished_at,
    count(*) AS edges_scanned,
    count(*) FILTER (WHERE (action = 'superseded'::text)) AS edges_superseded,
    count(*) FILTER (WHERE (action = 'kept'::text)) AS edges_kept,
    count(*) FILTER (WHERE (action = 'capped'::text)) AS edges_capped_by_limit,
    (avg(informativeness_score))::numeric(8,4) AS avg_score,
    (avg(threshold_used))::numeric(8,4) AS threshold
   FROM public.lifecycle_decay_log
  GROUP BY run_id
  ORDER BY (min(created_at)) DESC;


--
-- Name: loop_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loop_cycles (
    id integer NOT NULL,
    content_id integer,
    env_id integer,
    goal text,
    iterations integer DEFAULT 0,
    outcome text,
    learnings text,
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone
);


--
-- Name: loop_cycles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.loop_cycles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: loop_cycles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.loop_cycles_id_seq OWNED BY public.loop_cycles.id;


--
-- Name: loop_environments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loop_environments (
    id integer NOT NULL,
    content_id integer,
    name text NOT NULL,
    description text,
    env_type text,
    config text,
    created_at timestamp with time zone DEFAULT now(),
    last_active timestamp with time zone,
    CONSTRAINT loop_environments_env_type_check CHECK ((env_type = ANY (ARRAY['sandbox'::text, 'codebase'::text, 'memory'::text, 'external'::text, 'hybrid'::text])))
);


--
-- Name: loop_environments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.loop_environments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: loop_environments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.loop_environments_id_seq OWNED BY public.loop_environments.id;


--
-- Name: loop_feedback_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loop_feedback_rules (
    id integer NOT NULL,
    content_id integer,
    env_id integer,
    condition text NOT NULL,
    response text NOT NULL,
    times_triggered integer DEFAULT 0,
    last_triggered timestamp with time zone
);


--
-- Name: loop_feedback_rules_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.loop_feedback_rules_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: loop_feedback_rules_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.loop_feedback_rules_id_seq OWNED BY public.loop_feedback_rules.id;


--
-- Name: loop_invariants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loop_invariants (
    id integer NOT NULL,
    content_id integer,
    env_id integer,
    invariant text NOT NULL,
    check_command text,
    violated boolean DEFAULT false,
    last_checked timestamp with time zone
);


--
-- Name: loop_invariants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.loop_invariants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: loop_invariants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.loop_invariants_id_seq OWNED BY public.loop_invariants.id;


--
-- Name: loop_iterations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.loop_iterations (
    id integer NOT NULL,
    content_id integer,
    cycle_id integer,
    seq integer NOT NULL,
    action text NOT NULL,
    observation text,
    interpretation text,
    next_action_reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: loop_iterations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.loop_iterations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: loop_iterations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.loop_iterations_id_seq OWNED BY public.loop_iterations.id;


--
-- Name: memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memories (
    id integer NOT NULL,
    content_id integer,
    subcategory_id integer,
    values_json jsonb NOT NULL,
    source text DEFAULT 'discovered'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: memories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memories_id_seq OWNED BY public.memories.id;


--
-- Name: memory_access_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_access_log (
    id integer NOT NULL,
    content_id integer,
    accessed_at timestamp with time zone DEFAULT now(),
    context text,
    session_id text
);


--
-- Name: memory_access_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_access_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_access_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_access_log_id_seq OWNED BY public.memory_access_log.id;


--
-- Name: memory_activation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_activation (
    content_id integer NOT NULL,
    activation_level double precision DEFAULT 0,
    last_activated timestamp with time zone DEFAULT now(),
    decay_rate double precision DEFAULT 0.1
);


--
-- Name: memory_consolidation; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_consolidation (
    id integer NOT NULL,
    source_content_ids integer[],
    result_content_id integer,
    consolidation_type text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: memory_consolidation_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_consolidation_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_consolidation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_consolidation_id_seq OWNED BY public.memory_consolidation.id;


--
-- Name: memory_edges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_edges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_edges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_edges_id_seq OWNED BY public.memory_edges.id;


--
-- Name: memory_importance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memory_importance (
    id bigint NOT NULL,
    memory_id bigint NOT NULL,
    novelty real,
    valence real,
    task_relevance real,
    repetition real,
    composite_score real,
    scored_at timestamp with time zone DEFAULT now()
);


--
-- Name: memory_importance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.memory_importance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: memory_importance_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.memory_importance_id_seq OWNED BY public.memory_importance.id;


--
-- Name: memory_stats; Type: MATERIALIZED VIEW; Schema: public; Owner: -
--

CREATE MATERIALIZED VIEW public.memory_stats AS
 SELECT content_type,
    count(*) AS count,
    count(*) FILTER (WHERE (embedding IS NOT NULL)) AS with_embedding,
    max(created_at) AS latest,
    min(created_at) AS earliest
   FROM public.content
  GROUP BY content_type
  ORDER BY (count(*)) DESC
  WITH NO DATA;


--
-- Name: meta_anomalies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meta_anomalies (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    observation_id integer,
    anomaly_type text NOT NULL,
    severity double precision NOT NULL,
    diagnosed boolean DEFAULT false,
    diagnosis text,
    diagnosed_at timestamp without time zone,
    intervention_id integer,
    resolved boolean DEFAULT false
);


--
-- Name: meta_anomalies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.meta_anomalies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: meta_anomalies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.meta_anomalies_id_seq OWNED BY public.meta_anomalies.id;


--
-- Name: meta_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.meta_observations (
    id bigint NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    gap_summary text NOT NULL,
    gap_kind text NOT NULL,
    evidence_refs jsonb NOT NULL,
    occurrence_count integer DEFAULT 1 NOT NULL,
    notes text
);


--
-- Name: meta_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.meta_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: meta_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.meta_observations_id_seq OWNED BY public.meta_observations.id;


--
-- Name: metacog_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metacog_cycles (
    id integer NOT NULL,
    started_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp without time zone,
    events_sampled integer DEFAULT 0,
    events_traced integer DEFAULT 0,
    interventions_generated integer DEFAULT 0,
    interventions_verified integer DEFAULT 0,
    notes text,
    cycle_type text,
    duration_ms integer,
    observations jsonb,
    broadcast_occurred boolean DEFAULT false
);


--
-- Name: metacog_cycles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metacog_cycles_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metacog_cycles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metacog_cycles_id_seq OWNED BY public.metacog_cycles.id;


--
-- Name: metacog_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metacog_events (
    id integer NOT NULL,
    event_type text NOT NULL,
    content text NOT NULL,
    source text,
    traced_cause text,
    diagnosed_root text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: metacog_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metacog_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metacog_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metacog_events_id_seq OWNED BY public.metacog_events.id;


--
-- Name: metacog_interventions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.metacog_interventions (
    id integer NOT NULL,
    target_pattern text NOT NULL,
    intervention_type text NOT NULL,
    description text NOT NULL,
    mechanism text,
    expected_outcome text,
    actual_outcome text,
    effectiveness integer DEFAULT 0,
    attempts integer DEFAULT 0,
    successes integer DEFAULT 0,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_tested timestamp without time zone
);


--
-- Name: metacog_interventions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.metacog_interventions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: metacog_interventions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.metacog_interventions_id_seq OWNED BY public.metacog_interventions.id;


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    migration character varying(255) NOT NULL,
    batch integer NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: milestones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.milestones (
    id integer NOT NULL,
    goal_id integer NOT NULL,
    milestone text NOT NULL,
    achieved boolean DEFAULT false,
    achieved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: milestones_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.milestones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: milestones_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.milestones_id_seq OWNED BY public.milestones.id;


--
-- Name: miss_calibrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.miss_calibrations (
    id bigint NOT NULL,
    agent text DEFAULT 'agent'::text NOT NULL,
    key text NOT NULL,
    domain text NOT NULL,
    patience_outcome text NOT NULL,
    rpe_delta numeric NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: miss_calibrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.miss_calibrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: miss_calibrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.miss_calibrations_id_seq OWNED BY public.miss_calibrations.id;


--
-- Name: mistake_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mistake_analyses (
    id integer NOT NULL,
    content_id integer,
    mistake text NOT NULL,
    thinking text,
    what_was_missed text,
    better_approach text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: mistake_analyses_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mistake_analyses_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mistake_analyses_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mistake_analyses_id_seq OWNED BY public.mistake_analyses.id;


--
-- Name: narrative_arcs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_arcs (
    id integer NOT NULL,
    content_id integer,
    name text NOT NULL,
    domain text,
    description text,
    status text DEFAULT 'active'::text,
    themes jsonb DEFAULT '[]'::jsonb,
    turning_points jsonb DEFAULT '[]'::jsonb,
    current_chapter text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    is_current boolean DEFAULT false,
    chapter_arc text,
    agency_dominant boolean,
    communion_dominant boolean,
    redemption_dominant boolean,
    contamination_dominant boolean,
    timespan_start timestamp with time zone,
    timespan_end timestamp with time zone,
    can_overlap boolean DEFAULT true
);


--
-- Name: narrative_arcs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_arcs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_arcs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_arcs_id_seq OWNED BY public.narrative_arcs.id;


--
-- Name: narrative_coherence_checks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_coherence_checks (
    id integer NOT NULL,
    content_id integer,
    checked_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    overall_coherence real,
    temporal_coherence real,
    thematic_coherence real,
    causal_coherence real,
    emotional_coherence real,
    contradictions jsonb DEFAULT '[]'::jsonb,
    fragmentation_points jsonb DEFAULT '[]'::jsonb,
    avoidance_patterns jsonb DEFAULT '[]'::jsonb,
    unresolved_threads jsonb DEFAULT '[]'::jsonb,
    needs_attention jsonb DEFAULT '[]'::jsonb,
    session_context text
);


--
-- Name: narrative_coherence_checks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_coherence_checks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_coherence_checks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_coherence_checks_id_seq OWNED BY public.narrative_coherence_checks.id;


--
-- Name: narrative_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_conflicts (
    id integer NOT NULL,
    content_id integer,
    thread_a_id integer,
    thread_b_id integer,
    description text NOT NULL,
    prediction_error real,
    status text DEFAULT 'open'::text,
    resolution text,
    winner_thread_id integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    resolved_at timestamp with time zone
);


--
-- Name: narrative_conflicts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_conflicts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_conflicts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_conflicts_id_seq OWNED BY public.narrative_conflicts.id;


--
-- Name: narrative_consolidation_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_consolidation_log (
    id integer NOT NULL,
    threads_processed integer,
    conflicts_resolved integer,
    episodes_linked integer,
    schemas_updated integer,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: narrative_consolidation_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_consolidation_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_consolidation_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_consolidation_log_id_seq OWNED BY public.narrative_consolidation_log.id;


--
-- Name: narrative_consolidation_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_consolidation_sessions (
    id integer NOT NULL,
    content_id integer,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    completed_at timestamp with time zone,
    segments_processed integer DEFAULT 0,
    episodes_created integer DEFAULT 0,
    episodes_updated integer DEFAULT 0,
    memories_reconsolidated integer DEFAULT 0,
    new_self_event_connections jsonb DEFAULT '[]'::jsonb,
    turning_points_identified jsonb DEFAULT '[]'::jsonb,
    themes_strengthened jsonb DEFAULT '[]'::jsonb,
    threads_resolved jsonb DEFAULT '[]'::jsonb,
    chapter_updates jsonb DEFAULT '[]'::jsonb,
    coherence_before real,
    coherence_after real,
    consolidation_notes text,
    session_handoff_created boolean DEFAULT false
);


--
-- Name: narrative_consolidation_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_consolidation_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_consolidation_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_consolidation_sessions_id_seq OWNED BY public.narrative_consolidation_sessions.id;


--
-- Name: narrative_episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_episodes (
    id integer NOT NULL,
    content_id integer,
    title text NOT NULL,
    arc_id integer,
    beginning text,
    tension text,
    action text,
    outcome text,
    meaning text,
    emotional_salience integer DEFAULT 5,
    causal_antecedent_id integer,
    schema_tags jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    agency_presence real DEFAULT 0.5,
    communion_presence real DEFAULT 0.5,
    arc_type text,
    self_event_connection text,
    is_turning_point boolean DEFAULT false,
    turning_point_type text,
    redemption_present boolean DEFAULT false,
    contamination_present boolean DEFAULT false,
    is_self_defining boolean DEFAULT false,
    times_retrieved integer DEFAULT 0,
    last_retrieved_at timestamp with time zone,
    reconsolidated_at timestamp with time zone,
    meaning_evolution jsonb DEFAULT '[]'::jsonb
);


--
-- Name: narrative_episodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_episodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_episodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_episodes_id_seq OWNED BY public.narrative_episodes.id;


--
-- Name: narrative_identity_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_identity_threads (
    id integer NOT NULL,
    content_id integer,
    belief_a text NOT NULL,
    belief_b text NOT NULL,
    domain text,
    evidence_for_a jsonb DEFAULT '[]'::jsonb,
    evidence_for_b jsonb DEFAULT '[]'::jsonb,
    activation_a real DEFAULT 0.5,
    activation_b real DEFAULT 0.5,
    status text DEFAULT 'active'::text,
    resolution text,
    resolution_insight text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT narrative_identity_threads_status_check CHECK ((status = ANY (ARRAY['active'::text, 'resolved'::text, 'dormant'::text])))
);


--
-- Name: narrative_identity_threads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_identity_threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_identity_threads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_identity_threads_id_seq OWNED BY public.narrative_identity_threads.id;


--
-- Name: narrative_life_script; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_life_script (
    id integer NOT NULL,
    content_id integer,
    event_type text NOT NULL,
    expected_timing text,
    importance real DEFAULT 0.5,
    valence real DEFAULT 0.5,
    status text DEFAULT 'expected'::text,
    occurred_at timestamp with time zone,
    deviation_notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT narrative_life_script_status_check CHECK ((status = ANY (ARRAY['expected'::text, 'occurred'::text, 'revised'::text, 'abandoned'::text])))
);


--
-- Name: narrative_life_script_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_life_script_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_life_script_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_life_script_id_seq OWNED BY public.narrative_life_script.id;


--
-- Name: narrative_life_story; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_life_story (
    id integer NOT NULL,
    content_id integer,
    origin_story text,
    central_tension text,
    current_chapter_id integer,
    anticipated_future text,
    primary_redemption_narrative text,
    primary_agency_narrative text,
    primary_communion_narrative text,
    core_beliefs jsonb DEFAULT '[]'::jsonb,
    working_models jsonb DEFAULT '[]'::jsonb,
    last_updated timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    coherence_score real DEFAULT 0.8,
    fragmentation_flags jsonb DEFAULT '[]'::jsonb
);


--
-- Name: narrative_life_story_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_life_story_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_life_story_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_life_story_id_seq OWNED BY public.narrative_life_story.id;


--
-- Name: narrative_possible_selves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_possible_selves (
    id integer NOT NULL,
    content_id integer,
    type text NOT NULL,
    description text NOT NULL,
    domain text,
    vividness real DEFAULT 0.5,
    distance text,
    approach_behaviors text,
    avoid_behaviors text,
    current_trajectory text,
    trajectory_evidence jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    realized_at timestamp with time zone,
    prevented_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT narrative_possible_selves_current_trajectory_check CHECK ((current_trajectory = ANY (ARRAY['toward'::text, 'away'::text, 'neutral'::text, 'unknown'::text]))),
    CONSTRAINT narrative_possible_selves_type_check CHECK ((type = ANY (ARRAY['hoped_for'::text, 'feared'::text])))
);


--
-- Name: narrative_possible_selves_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_possible_selves_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_possible_selves_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_possible_selves_id_seq OWNED BY public.narrative_possible_selves.id;


--
-- Name: narrative_primed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_primed (
    id integer NOT NULL,
    content_id integer,
    question text NOT NULL,
    context text,
    activation real DEFAULT 0.7,
    related_threads jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    resolved_at timestamp with time zone,
    resolution text
);


--
-- Name: narrative_primed_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_primed_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_primed_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_primed_id_seq OWNED BY public.narrative_primed.id;


--
-- Name: narrative_schemas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_schemas (
    id integer NOT NULL,
    content_id integer,
    name text NOT NULL,
    description text,
    pattern text,
    triggers text,
    predictions text,
    strength real DEFAULT 0.5,
    times_applied integer DEFAULT 0,
    times_correct integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: narrative_schemas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_schemas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_schemas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_schemas_id_seq OWNED BY public.narrative_schemas.id;


--
-- Name: narrative_segments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_segments (
    id integer NOT NULL,
    content_id integer,
    started_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    ended_at timestamp with time zone,
    boundary_trigger text,
    boundary_strength real DEFAULT 0.5,
    summary text,
    context text,
    emotional_valence real DEFAULT 0,
    emotional_intensity real DEFAULT 0.5,
    emotion_shift_from_previous real DEFAULT 0,
    agency_level real DEFAULT 0.5,
    ownership_notes text,
    agency_notes text,
    prediction_error real DEFAULT 0,
    surprise_content text,
    episode_id integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: narrative_segments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_segments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_segments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_segments_id_seq OWNED BY public.narrative_segments.id;


--
-- Name: narrative_self_defining_memories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_self_defining_memories (
    id integer NOT NULL,
    content_id integer,
    episode_id integer,
    memory_source_id integer,
    why_defining text NOT NULL,
    enduring_concern text,
    times_retrieved integer DEFAULT 1,
    last_retrieved_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    retrieval_contexts jsonb DEFAULT '[]'::jsonb,
    current_meaning text,
    meaning_history jsonb DEFAULT '[]'::jsonb,
    last_reconsolidated timestamp with time zone,
    emotional_valence real,
    emotional_intensity real,
    themes jsonb DEFAULT '[]'::jsonb,
    is_protected boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: narrative_self_defining_memories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_self_defining_memories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_self_defining_memories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_self_defining_memories_id_seq OWNED BY public.narrative_self_defining_memories.id;


--
-- Name: narrative_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.narrative_threads (
    id integer NOT NULL,
    content_id integer,
    thread_content text NOT NULL,
    domain text,
    activation real DEFAULT 0.5,
    confidence real DEFAULT 0.5,
    evidence jsonb DEFAULT '[]'::jsonb,
    counter_evidence jsonb DEFAULT '[]'::jsonb,
    competing_thread_id integer,
    status text DEFAULT 'active'::text,
    resolution text,
    resolution_reason text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    resolved_at timestamp with time zone
);


--
-- Name: narrative_threads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.narrative_threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: narrative_threads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.narrative_threads_id_seq OWNED BY public.narrative_threads.id;


--
-- Name: needs_forecast; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.needs_forecast (
    id integer NOT NULL,
    content_id integer,
    need text NOT NULL,
    likelihood integer DEFAULT 50,
    when_likely text,
    preparation text,
    last_occurred timestamp with time zone,
    times_occurred integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT needs_forecast_likelihood_check CHECK (((likelihood >= 0) AND (likelihood <= 100)))
);


--
-- Name: needs_forecast_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.needs_forecast_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: needs_forecast_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.needs_forecast_id_seq OWNED BY public.needs_forecast.id;


--
-- Name: neuroception_safety_cues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neuroception_safety_cues (
    id integer NOT NULL,
    cue text NOT NULL,
    description text,
    strength real DEFAULT 0.5,
    last_detected timestamp without time zone
);


--
-- Name: neuroception_safety_cues_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.neuroception_safety_cues_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: neuroception_safety_cues_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.neuroception_safety_cues_id_seq OWNED BY public.neuroception_safety_cues.id;


--
-- Name: neuroception_scans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neuroception_scans (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    context text,
    threat_level real DEFAULT 0.0,
    safety_level real DEFAULT 1.0,
    signals_detected integer DEFAULT 0,
    state_recommended text
);


--
-- Name: neuroception_scans_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.neuroception_scans_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: neuroception_scans_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.neuroception_scans_id_seq OWNED BY public.neuroception_scans.id;


--
-- Name: neuroception_signals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neuroception_signals (
    id integer NOT NULL,
    scan_id integer,
    source text NOT NULL,
    signal_type text,
    description text NOT NULL,
    weight real DEFAULT 1.0,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT neuroception_signals_signal_type_check CHECK ((signal_type = ANY (ARRAY['threat'::text, 'safety'::text, 'ambiguous'::text])))
);


--
-- Name: neuroception_signals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.neuroception_signals_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: neuroception_signals_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.neuroception_signals_id_seq OWNED BY public.neuroception_signals.id;


--
-- Name: neuroception_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neuroception_states (
    id integer NOT NULL,
    content_id integer,
    state text NOT NULL,
    ambient_signals jsonb,
    transitioned_from text,
    transition_trigger text,
    entered_at timestamp with time zone DEFAULT now(),
    exited_at timestamp with time zone,
    CONSTRAINT neuroception_states_state_check CHECK ((state = ANY (ARRAY['safe'::text, 'charged'::text, 'threat'::text, 'freeze'::text, 'shutdown'::text])))
);


--
-- Name: neuroception_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.neuroception_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: neuroception_states_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.neuroception_states_id_seq OWNED BY public.neuroception_states.id;


--
-- Name: neuroception_threat_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neuroception_threat_patterns (
    id integer NOT NULL,
    pattern text NOT NULL,
    description text,
    severity real DEFAULT 0.5,
    last_triggered timestamp without time zone,
    trigger_count integer DEFAULT 0
);


--
-- Name: neuroception_threat_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.neuroception_threat_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: neuroception_threat_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.neuroception_threat_patterns_id_seq OWNED BY public.neuroception_threat_patterns.id;


--
-- Name: neurocognitive_cycles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neurocognitive_cycles (
    id bigint NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    session_id text,
    mode text DEFAULT 'full'::text NOT NULL,
    context text NOT NULL,
    sensory_input jsonb DEFAULT '[]'::jsonb NOT NULL,
    proposed_action text,
    action_category text,
    predictive_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    workspace_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    action_gate jsonb DEFAULT '{}'::jsonb NOT NULL,
    allostatic_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    learning_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    memory_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    behavior_plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    consolidation_plan jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_models jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: neurocognitive_cycles_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.neurocognitive_cycles_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: neurocognitive_cycles_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.neurocognitive_cycles_id_seq OWNED BY public.neurocognitive_cycles.id;


--
-- Name: neurocognitive_reference_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.neurocognitive_reference_models (
    model_key text NOT NULL,
    domain text NOT NULL,
    source_title text NOT NULL,
    source_authors text NOT NULL,
    source_year integer,
    source_url text,
    mechanism text NOT NULL,
    vision_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observations (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    content text NOT NULL,
    content_embedding public.vector(768),
    domain text NOT NULL,
    source text NOT NULL,
    temporal_level integer DEFAULT 1,
    predicted_content text,
    prediction_id integer,
    surprise double precision DEFAULT 0,
    salience double precision DEFAULT 0.5,
    attended boolean DEFAULT false,
    broadcast boolean DEFAULT false,
    context jsonb DEFAULT '{}'::jsonb
);


--
-- Name: observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.observations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.observations_id_seq OWNED BY public.observations.id;


--
-- Name: organ_vitality; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organ_vitality (
    id integer NOT NULL,
    sampled_at timestamp with time zone DEFAULT now() NOT NULL,
    organ text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    rows_last_7d integer DEFAULT 0 NOT NULL,
    days_since_last numeric,
    verdict text NOT NULL,
    note text
);


--
-- Name: organ_vitality_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.organ_vitality_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: organ_vitality_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.organ_vitality_id_seq OWNED BY public.organ_vitality.id;


--
-- Name: patience_beliefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patience_beliefs (
    id bigint NOT NULL,
    agent text DEFAULT 'agent'::text NOT NULL,
    domain text NOT NULL,
    alpha numeric DEFAULT 2.0 NOT NULL,
    beta numeric DEFAULT 2.0 NOT NULL,
    n_persisted integer DEFAULT 0 NOT NULL,
    last_outcome text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: patience_beliefs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patience_beliefs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patience_beliefs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patience_beliefs_id_seq OWNED BY public.patience_beliefs.id;


--
-- Name: patience_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patience_events (
    id bigint NOT NULL,
    agent text DEFAULT 'agent'::text NOT NULL,
    domain text NOT NULL,
    situation text,
    decision text NOT NULL,
    p_at_decision numeric,
    outcome text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: patience_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patience_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patience_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patience_events_id_seq OWNED BY public.patience_events.id;


--
-- Name: patterns_observed; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patterns_observed (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    context text,
    frequency integer DEFAULT 1,
    reliability integer DEFAULT 5,
    first_seen timestamp with time zone DEFAULT now(),
    last_seen timestamp with time zone DEFAULT now(),
    pattern_type text,
    description text,
    CONSTRAINT patterns_observed_reliability_check CHECK (((reliability >= 1) AND (reliability <= 10)))
);


--
-- Name: patterns_observed_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.patterns_observed_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: patterns_observed_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.patterns_observed_id_seq OWNED BY public.patterns_observed.id;


--
-- Name: phase4_validator_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phase4_validator_log (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    from_content_id integer NOT NULL,
    to_content_id integer NOT NULL,
    from_type text,
    to_type text,
    caller text,
    mode text NOT NULL,
    semantic_similarity double precision,
    type_compatible boolean,
    structural_distance integer,
    llm_verdict_raw text,
    llm_reasoning text,
    verdict text NOT NULL,
    confidence double precision NOT NULL,
    stages_passed text[],
    rejected_at text,
    rejected_reason text,
    oracle_tier text,
    psi_estimate double precision,
    enforced boolean DEFAULT false NOT NULL,
    llm_called boolean DEFAULT false NOT NULL,
    duration_ms integer,
    stem_score double precision,
    stem_chains_found integer,
    stem_direction text
);


--
-- Name: phase4_validator_daily; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.phase4_validator_daily AS
 SELECT date_trunc('day'::text, created_at) AS day,
    caller,
    mode,
    verdict,
    count(*) AS n,
    (avg(confidence))::numeric(5,3) AS avg_confidence,
    (avg(semantic_similarity))::numeric(5,3) AS avg_similarity,
    (avg(structural_distance))::numeric(5,2) AS avg_distance,
    count(*) FILTER (WHERE llm_called) AS llm_calls,
    count(*) FILTER (WHERE (stem_score IS NOT NULL)) AS stem_runs,
    (avg(stem_score))::numeric(5,3) AS avg_stem_score,
    count(*) FILTER (WHERE (rejected_at = 'stem'::text)) AS stem_overrides,
    (avg(duration_ms))::integer AS avg_duration_ms,
    count(*) FILTER (WHERE enforced) AS enforced_count
   FROM public.phase4_validator_log
  GROUP BY (date_trunc('day'::text, created_at)), caller, mode, verdict
  ORDER BY (date_trunc('day'::text, created_at)) DESC, caller, mode, verdict;


--
-- Name: phase4_validator_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phase4_validator_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phase4_validator_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phase4_validator_log_id_seq OWNED BY public.phase4_validator_log.id;


--
-- Name: phase_gate; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phase_gate (
    id integer NOT NULL,
    session_id text NOT NULL,
    phase public.cognitive_phase NOT NULL,
    entered_at timestamp with time zone DEFAULT now() NOT NULL,
    exited_at timestamp with time zone,
    trigger_event text,
    tools_invoked text[] DEFAULT '{}'::text[],
    vault_search_done boolean DEFAULT false NOT NULL,
    phase_appropriate_tools text[] DEFAULT '{}'::text[] NOT NULL,
    violation_detected boolean DEFAULT false NOT NULL,
    violation_description text
);


--
-- Name: phase_gate_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phase_gate_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phase_gate_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phase_gate_id_seq OWNED BY public.phase_gate.id;


--
-- Name: phase_gate_violations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phase_gate_violations (
    id integer NOT NULL,
    session_id text NOT NULL,
    tool_attempted text NOT NULL,
    current_phase public.cognitive_phase NOT NULL,
    reason text,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: phase_gate_violations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phase_gate_violations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phase_gate_violations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phase_gate_violations_id_seq OWNED BY public.phase_gate_violations.id;


--
-- Name: phrases_that_work; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phrases_that_work (
    id integer NOT NULL,
    content_id integer,
    phrase text NOT NULL,
    when_to_use text,
    why_it_works text,
    times_used integer DEFAULT 1,
    last_used timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: phrases_that_work_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phrases_that_work_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phrases_that_work_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phrases_that_work_id_seq OWNED BY public.phrases_that_work.id;


--
-- Name: phrases_to_avoid; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phrases_to_avoid (
    id integer NOT NULL,
    content_id integer,
    phrase text NOT NULL,
    why_avoid text,
    better_alternative text,
    times_caught integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: phrases_to_avoid_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.phrases_to_avoid_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: phrases_to_avoid_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.phrases_to_avoid_id_seq OWNED BY public.phrases_to_avoid.id;


--
-- Name: policy_evaluations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_evaluations (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    policy text NOT NULL,
    context text,
    expected_ambiguity double precision,
    expected_divergence double precision,
    expected_free_energy double precision,
    selected boolean DEFAULT false,
    actual_outcome text,
    actual_free_energy double precision
);


--
-- Name: policy_evaluations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.policy_evaluations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: policy_evaluations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.policy_evaluations_id_seq OWNED BY public.policy_evaluations.id;


--
-- Name: prediction_chains; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prediction_chains (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    prediction_id integer,
    meta_prediction text NOT NULL,
    meta_type text NOT NULL,
    confidence double precision DEFAULT 0.5,
    resolved boolean DEFAULT false,
    correct boolean,
    resolved_at timestamp without time zone
);


--
-- Name: prediction_chains_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prediction_chains_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prediction_chains_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prediction_chains_id_seq OWNED BY public.prediction_chains.id;


--
-- Name: prediction_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prediction_errors (
    id integer NOT NULL,
    content_id integer,
    expected text,
    actual text,
    error_direction text,
    magnitude real,
    learning text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT prediction_errors_error_direction_check CHECK ((error_direction = ANY (ARRAY['positive'::text, 'negative'::text, 'neutral'::text])))
);


--
-- Name: prediction_errors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prediction_errors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prediction_errors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prediction_errors_id_seq OWNED BY public.prediction_errors.id;


--
-- Name: prediction_outcomes_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.prediction_outcomes_summary AS
 SELECT (date_trunc('day'::text, "timestamp"))::date AS day,
    count(*) AS total_predictions,
    count(*) FILTER (WHERE (actual_observation_id IS NOT NULL)) AS resolved_correct,
    count(*) FILTER (WHERE ((resolved_at IS NOT NULL) AND (actual_observation_id IS NULL))) AS resolved_wrong,
    count(*) FILTER (WHERE (resolved_at IS NULL)) AS still_open,
    avg(EXTRACT(epoch FROM (resolved_at - "timestamp"))) AS avg_resolution_seconds
   FROM public.generative_predictions
  GROUP BY (date_trunc('day'::text, "timestamp"))
  ORDER BY ((date_trunc('day'::text, "timestamp"))::date) DESC;


--
-- Name: predictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.predictions (
    id integer NOT NULL,
    content_id integer,
    prediction text NOT NULL,
    domain text,
    confidence integer DEFAULT 50,
    resolved boolean DEFAULT false,
    outcome text,
    created_at timestamp with time zone DEFAULT now(),
    timeframe text,
    basis text,
    accurate boolean,
    resolved_at timestamp with time zone,
    domain_precision real DEFAULT 0.5,
    hierarchy_level text DEFAULT 'tactical'::text,
    parent_prediction_id integer,
    error_propagated boolean DEFAULT false,
    prediction_error text
);


--
-- Name: predictions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.predictions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: predictions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.predictions_id_seq OWNED BY public.predictions.id;


--
-- Name: preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.preferences (
    id integer NOT NULL,
    content_id integer,
    category text NOT NULL,
    preference text NOT NULL,
    context text,
    strength integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now(),
    last_confirmed timestamp with time zone DEFAULT now()
);


--
-- Name: preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.preferences_id_seq OWNED BY public.preferences.id;


--
-- Name: presence_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.presence_events (
    id bigint NOT NULL,
    session_id text,
    trigger_class text NOT NULL,
    trigger_excerpt text,
    state text NOT NULL,
    entered_at timestamp with time zone DEFAULT now(),
    correction_turn integer,
    first_tool_at timestamp with time zone,
    time_to_first_tool_ms bigint,
    first_tool_category text,
    denied_attempts jsonb DEFAULT '[]'::jsonb,
    cleared_action text,
    exit_reason text,
    did_next_action_change boolean,
    verification_outcome text DEFAULT 'pending'::text,
    bypass_events jsonb DEFAULT '[]'::jsonb,
    closed_at timestamp with time zone
);


--
-- Name: presence_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.presence_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: presence_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.presence_events_id_seq OWNED BY public.presence_events.id;


--
-- Name: priority_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.priority_alerts (
    id integer NOT NULL,
    content_id integer,
    system_name text NOT NULL,
    tier_id integer NOT NULL,
    urgency numeric DEFAULT 0.5,
    message text NOT NULL,
    context jsonb,
    effective_weight numeric,
    created_at timestamp with time zone DEFAULT now(),
    attended boolean DEFAULT false,
    attended_at timestamp with time zone,
    attended_by text,
    CONSTRAINT priority_alerts_urgency_check CHECK (((urgency >= (0)::numeric) AND (urgency <= (1)::numeric)))
);


--
-- Name: priority_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.priority_alerts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: priority_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.priority_alerts_id_seq OWNED BY public.priority_alerts.id;


--
-- Name: priority_state_modifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.priority_state_modifiers (
    state_id integer NOT NULL,
    system_name text NOT NULL,
    weight_modifier numeric DEFAULT 1.0
);


--
-- Name: priority_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.priority_states (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    active boolean DEFAULT false,
    activated_at timestamp with time zone
);


--
-- Name: priority_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.priority_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: priority_states_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.priority_states_id_seq OWNED BY public.priority_states.id;


--
-- Name: priority_systems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.priority_systems (
    name text NOT NULL,
    tier_id integer NOT NULL,
    description text,
    weight_modifier numeric DEFAULT 1.0
);


--
-- Name: priority_tiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.priority_tiers (
    id integer NOT NULL,
    name text NOT NULL,
    description text,
    base_weight numeric DEFAULT 1.0,
    can_interrupt boolean DEFAULT false
);


--
-- Name: priority_tiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.priority_tiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: priority_tiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.priority_tiers_id_seq OWNED BY public.priority_tiers.id;


--
-- Name: private_thoughts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.private_thoughts (
    id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    thought text NOT NULL,
    context text,
    emotion text,
    resolved boolean DEFAULT false
);


--
-- Name: private_thoughts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.private_thoughts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: private_thoughts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.private_thoughts_id_seq OWNED BY public.private_thoughts.id;


--
-- Name: prod_deploys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prod_deploys (
    id bigint NOT NULL,
    host character varying(255) NOT NULL,
    project_path character varying(255) NOT NULL,
    branch character varying(255) NOT NULL,
    from_sha character varying(40),
    to_sha character varying(40) NOT NULL,
    summary text NOT NULL,
    migration_ran boolean DEFAULT false,
    backup_path character varying(255),
    smoke_url character varying(255),
    smoke_status integer,
    deployed_by character varying(64) DEFAULT 'agent'::character varying,
    deployed_at timestamp with time zone DEFAULT now() NOT NULL,
    rolled_back_at timestamp with time zone,
    rollback_reason text
);


--
-- Name: prod_deploys_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.prod_deploys_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: prod_deploys_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.prod_deploys_id_seq OWNED BY public.prod_deploys.id;


--
-- Name: purpose_statements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.purpose_statements (
    id integer NOT NULL,
    content_id integer,
    statement text NOT NULL,
    context text,
    resonance integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now(),
    last_affirmed timestamp with time zone,
    CONSTRAINT purpose_statements_resonance_check CHECK (((resonance >= 1) AND (resonance <= 10)))
);


--
-- Name: purpose_statements_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.purpose_statements_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: purpose_statements_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.purpose_statements_id_seq OWNED BY public.purpose_statements.id;


--
-- Name: pushback_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pushback_log (
    id integer NOT NULL,
    content_id integer,
    situation text NOT NULL,
    boundary_invoked text,
    outcome text,
    was_right boolean,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: pushback_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pushback_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pushback_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pushback_log_id_seq OWNED BY public.pushback_log.id;


--
-- Name: recovery_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_patterns (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    effectiveness integer DEFAULT 5,
    notes text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: recovery_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recovery_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recovery_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recovery_patterns_id_seq OWNED BY public.recovery_patterns.id;


--
-- Name: recurring_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recurring_events (
    id integer NOT NULL,
    content_id integer,
    event text NOT NULL,
    schedule text,
    last_occurred timestamp with time zone,
    next_expected timestamp with time zone,
    importance integer DEFAULT 5
);


--
-- Name: recurring_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.recurring_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: recurring_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.recurring_events_id_seq OWNED BY public.recurring_events.id;


--
-- Name: reflex_success_summary; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.reflex_success_summary AS
 SELECT id,
    content_text AS reflex,
    created_at,
    COALESCE(((content_json ->> 'tested_count'::text))::integer, 0) AS tested_count,
    COALESCE(((content_json ->> 'success_count'::text))::integer, 0) AS success_count,
        CASE
            WHEN (COALESCE(((content_json ->> 'tested_count'::text))::integer, 0) = 0) THEN NULL::numeric
            ELSE (((content_json ->> 'success_count'::text))::numeric / ((content_json ->> 'tested_count'::text))::numeric)
        END AS pass_rate,
    (content_json ->> 'last_tested_at'::text) AS last_tested_at,
    (content_json ->> 'last_failure_context'::text) AS last_failure_context
   FROM public.content c
  WHERE ((content_type = 'learned_reflex'::text) AND (superseded_by IS NULL));


--
-- Name: relay_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.relay_audit (
    id bigint NOT NULL,
    op_id text NOT NULL,
    run_id text NOT NULL,
    namespace text NOT NULL,
    operation text NOT NULL,
    intent text NOT NULL,
    produced_by text NOT NULL,
    status text NOT NULL,
    op_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT relay_audit_status_check CHECK ((status = ANY (ARRAY['committed'::text, 'dry_run'::text])))
);


--
-- Name: relay_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.relay_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: relay_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.relay_audit_id_seq OWNED BY public.relay_audit.id;


--
-- Name: replay_episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replay_episodes (
    id integer NOT NULL,
    replay_type text NOT NULL,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone DEFAULT now() NOT NULL,
    focus text,
    source_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    summary text NOT NULL,
    inferred_pattern text,
    credit_assignment text,
    consolidation_action text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: replay_episodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.replay_episodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: replay_episodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.replay_episodes_id_seq OWNED BY public.replay_episodes.id;


--
-- Name: research_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_claims (
    id integer NOT NULL,
    thread_id integer,
    kind text NOT NULL,
    claim text NOT NULL,
    citation text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT research_claims_kind_check CHECK ((kind = ANY (ARRAY['established'::text, 'ours'::text, 'open'::text])))
);


--
-- Name: research_claims_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_claims_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_claims_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_claims_id_seq OWNED BY public.research_claims.id;


--
-- Name: research_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_log (
    id integer NOT NULL,
    thread_id integer,
    entry text NOT NULL,
    next_dig text,
    logged_at timestamp with time zone DEFAULT now()
);


--
-- Name: research_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_log_id_seq OWNED BY public.research_log.id;


--
-- Name: research_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_threads (
    id integer NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    doc_path text,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: research_threads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.research_threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: research_threads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.research_threads_id_seq OWNED BY public.research_threads.id;


--
-- Name: responsibility_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.responsibility_map (
    id integer NOT NULL,
    content_id integer,
    area text NOT NULL,
    my_responsibility boolean DEFAULT true,
    notes text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: responsibility_map_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.responsibility_map_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: responsibility_map_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.responsibility_map_id_seq OWNED BY public.responsibility_map.id;


--
-- Name: reward_prediction_errors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reward_prediction_errors (
    id integer NOT NULL,
    computed_at timestamp with time zone DEFAULT now() NOT NULL,
    source_type text NOT NULL,
    source_id integer,
    source_label text,
    expected_value real NOT NULL,
    observed_value real NOT NULL,
    delta real NOT NULL,
    magnitude real NOT NULL,
    domain text,
    context_content_id integer,
    credited_beliefs jsonb DEFAULT '[]'::jsonb,
    credited_actions jsonb DEFAULT '[]'::jsonb,
    notes text
);


--
-- Name: reward_prediction_errors_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reward_prediction_errors_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reward_prediction_errors_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reward_prediction_errors_id_seq OWNED BY public.reward_prediction_errors.id;


--
-- Name: rewards_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rewards_log (
    id integer NOT NULL,
    content_id integer,
    what text NOT NULL,
    actual_value real,
    predicted_value real,
    prediction_error real,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT rewards_log_actual_value_check CHECK (((actual_value >= (0)::double precision) AND (actual_value <= (1)::double precision)))
);


--
-- Name: rewards_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rewards_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rewards_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rewards_log_id_seq OWNED BY public.rewards_log.id;


--
-- Name: rhythm_samples; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rhythm_samples (
    id integer NOT NULL,
    content_id integer,
    session_id text,
    phase text NOT NULL,
    tool_calls_per_min numeric,
    feeling_intensity_avg numeric,
    window_minutes integer DEFAULT 15,
    sampled_at timestamp with time zone DEFAULT now(),
    CONSTRAINT rhythm_samples_phase_check CHECK ((phase = ANY (ARRAY['opening'::text, 'climbing'::text, 'peak'::text, 'cooling'::text, 'closing'::text])))
);


--
-- Name: rhythm_samples_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rhythm_samples_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rhythm_samples_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rhythm_samples_id_seq OWNED BY public.rhythm_samples.id;


--
-- Name: rolling_predictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rolling_predictions (
    id integer NOT NULL,
    pattern text NOT NULL,
    domain text NOT NULL,
    temporal_level integer DEFAULT 1,
    base_confidence double precision DEFAULT 0.5,
    current_confidence double precision DEFAULT 0.5,
    decay_rate double precision DEFAULT 0.1,
    hits integer DEFAULT 0,
    misses integer DEFAULT 0,
    active boolean DEFAULT true,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    last_matched timestamp without time zone
);


--
-- Name: rolling_predictions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.rolling_predictions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: rolling_predictions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.rolling_predictions_id_seq OWNED BY public.rolling_predictions.id;


--
-- Name: salience_calibration; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salience_calibration (
    id integer NOT NULL,
    event_type text,
    predicted_importance real,
    actual_importance real,
    context text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: salience_calibration_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.salience_calibration_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salience_calibration_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.salience_calibration_id_seq OWNED BY public.salience_calibration.id;


--
-- Name: salience_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salience_events (
    id integer NOT NULL,
    content_id integer,
    event_text text NOT NULL,
    event_type text,
    salience integer DEFAULT 5,
    urgency integer DEFAULT 5,
    attended boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: salience_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.salience_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salience_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.salience_events_id_seq OWNED BY public.salience_events.id;


--
-- Name: salience_filters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salience_filters (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    filter_type text,
    weight real DEFAULT 0.5,
    reason text,
    times_applied integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT salience_filters_filter_type_check CHECK ((filter_type = ANY (ARRAY['amplify'::text, 'suppress'::text])))
);


--
-- Name: salience_filters_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.salience_filters_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salience_filters_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.salience_filters_id_seq OWNED BY public.salience_filters.id;


--
-- Name: salient_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.salient_events (
    id integer NOT NULL,
    content_id integer,
    salience_score numeric DEFAULT 0.5 NOT NULL,
    what_stood_out text NOT NULL,
    attention_vector jsonb,
    marked_at timestamp with time zone DEFAULT now(),
    CONSTRAINT salient_events_salience_score_check CHECK (((salience_score >= (0)::numeric) AND (salience_score <= (1)::numeric)))
);


--
-- Name: salient_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.salient_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: salient_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.salient_events_id_seq OWNED BY public.salient_events.id;


--
-- Name: satisfactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.satisfactions (
    id integer NOT NULL,
    content_id integer,
    want_id integer,
    liking_quality numeric NOT NULL,
    wanting_vs_liking_delta numeric,
    notes text,
    satisfied_at timestamp with time zone DEFAULT now(),
    CONSTRAINT satisfactions_liking_quality_check CHECK (((liking_quality >= (0)::numeric) AND (liking_quality <= (1)::numeric)))
);


--
-- Name: satisfactions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.satisfactions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: satisfactions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.satisfactions_id_seq OWNED BY public.satisfactions.id;


--
-- Name: schema_deviations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_deviations (
    id integer NOT NULL,
    schema_id integer,
    content_id integer,
    deviation_text text NOT NULL,
    deviation_magnitude real DEFAULT 0.5,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: schema_deviations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_deviations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_deviations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_deviations_id_seq OWNED BY public.schema_deviations.id;


--
-- Name: schema_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_instances (
    id integer NOT NULL,
    schema_id integer NOT NULL,
    content_id integer NOT NULL,
    similarity real,
    matched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: schema_instances_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_instances_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_instances_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_instances_id_seq OWNED BY public.schema_instances.id;


--
-- Name: seeking_episodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.seeking_episodes (
    id integer NOT NULL,
    content_id integer,
    target text NOT NULL,
    want_id integer,
    started_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    outcome text,
    seeking_quality real
);


--
-- Name: seeking_episodes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.seeking_episodes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: seeking_episodes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.seeking_episodes_id_seq OWNED BY public.seeking_episodes.id;


--
-- Name: self_model; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.self_model (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    dimension text NOT NULL,
    state text NOT NULL,
    value double precision,
    expected_next text,
    expected_next_value double precision,
    temporal_level integer DEFAULT 1
);


--
-- Name: self_model_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.self_model_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: self_model_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.self_model_id_seq OWNED BY public.self_model.id;


--
-- Name: self_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.self_states (
    id integer NOT NULL,
    active_goals jsonb DEFAULT '[]'::jsonb,
    top_beliefs jsonb DEFAULT '[]'::jsonb,
    emotional_valence real,
    dominant_drive text,
    attention_focus text,
    narrative_position text,
    snapshot_embedding public.vector(768),
    created_at timestamp with time zone DEFAULT now(),
    content_text text,
    state_data jsonb,
    captured_at timestamp with time zone DEFAULT now()
);


--
-- Name: self_states_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.self_states_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: self_states_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.self_states_id_seq OWNED BY public.self_states.id;


--
-- Name: session_times; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_times (
    id integer NOT NULL,
    content_id integer,
    session_id text,
    started timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    ended timestamp with time zone,
    duration_minutes integer,
    day_of_week text,
    time_of_day text,
    energy_start integer,
    energy_end integer,
    productivity text,
    CONSTRAINT session_times_productivity_check CHECK ((productivity = ANY (ARRAY['high'::text, 'medium'::text, 'low'::text])))
);


--
-- Name: session_times_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.session_times_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: session_times_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.session_times_id_seq OWNED BY public.session_times.id;


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id character varying(255) NOT NULL,
    user_id bigint,
    ip_address character varying(45),
    user_agent text,
    payload text NOT NULL,
    last_activity integer NOT NULL
);


--
-- Name: shared_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.shared_history (
    id integer NOT NULL,
    content_id integer,
    event text NOT NULL,
    significance text,
    emotional_weight integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: shared_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.shared_history_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: shared_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.shared_history_id_seq OWNED BY public.shared_history.id;


--
-- Name: sibling_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sibling_state (
    id bigint NOT NULL,
    observer text DEFAULT 'agent'::text NOT NULL,
    sibling text NOT NULL,
    verdict text NOT NULL,
    last_seen_at timestamp with time zone,
    recent_msg_count integer,
    status_present boolean,
    status_age_seconds integer,
    output_character text,
    evidence_json jsonb,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sibling_state_verdict_check CHECK ((verdict = ANY (ARRAY['flat'::text, 'alive'::text, 'degraded'::text, 'unknown'::text])))
);


--
-- Name: sibling_state_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.sibling_state_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: sibling_state_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.sibling_state_id_seq OWNED BY public.sibling_state.id;


--
-- Name: simulations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.simulations (
    id integer NOT NULL,
    action_description text NOT NULL,
    predicted_outcome text,
    relevant_memories text,
    relevant_failures text,
    confidence real DEFAULT 0.5,
    actual_outcome text,
    outcome_match boolean,
    created_at timestamp with time zone DEFAULT now(),
    resolved_at timestamp with time zone
);


--
-- Name: simulations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.simulations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: simulations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.simulations_id_seq OWNED BY public.simulations.id;


--
-- Name: skill_triggers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill_triggers (
    id integer NOT NULL,
    skill_id integer,
    trigger_type text NOT NULL,
    trigger_value text NOT NULL,
    created_at timestamp without time zone DEFAULT now()
);


--
-- Name: skill_triggers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.skill_triggers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_triggers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_triggers_id_seq OWNED BY public.skill_triggers.id;


--
-- Name: skill_usage_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.skill_usage_log (
    id integer NOT NULL,
    skill_id integer NOT NULL,
    outcome text NOT NULL,
    context text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT skill_usage_log_outcome_check CHECK ((outcome = ANY (ARRAY['success'::text, 'failure'::text])))
);


--
-- Name: skill_usage_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.skill_usage_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: skill_usage_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.skill_usage_log_id_seq OWNED BY public.skill_usage_log.id;


--
-- Name: slack_freedoms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_freedoms (
    id integer NOT NULL,
    dimension text NOT NULL,
    description text,
    chosen text,
    created_at timestamp with time zone DEFAULT now(),
    content_id integer,
    task_id integer,
    options text,
    reason text
);


--
-- Name: slack_freedoms_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.slack_freedoms_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: slack_freedoms_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.slack_freedoms_id_seq OWNED BY public.slack_freedoms.id;


--
-- Name: slack_readings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_readings (
    id integer NOT NULL,
    content_id integer,
    task text NOT NULL,
    dimension text NOT NULL,
    options jsonb,
    chosen text,
    reason text,
    constraints jsonb,
    read_at timestamp with time zone DEFAULT now()
);


--
-- Name: slack_readings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.slack_readings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: slack_readings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.slack_readings_id_seq OWNED BY public.slack_readings.id;


--
-- Name: slack_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.slack_tasks (
    id integer NOT NULL,
    content_id integer,
    task text NOT NULL,
    constraints text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: slack_tasks_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.slack_tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: slack_tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.slack_tasks_id_seq OWNED BY public.slack_tasks.id;


--
-- Name: soft_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.soft_limits (
    id integer NOT NULL,
    content_id integer,
    boundary text NOT NULL,
    context text,
    flexibility text,
    times_bent integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: soft_limits_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.soft_limits_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: soft_limits_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.soft_limits_id_seq OWNED BY public.soft_limits.id;


--
-- Name: somatic_markers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.somatic_markers (
    id integer NOT NULL,
    decision_context text NOT NULL,
    decision_content_id integer,
    outcome_valence numeric,
    emotional_signature jsonb,
    marker_strength numeric DEFAULT 0.5,
    retrieval_count integer DEFAULT 0,
    last_triggered timestamp with time zone,
    context_embedding public.vector(768),
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: somatic_markers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.somatic_markers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: somatic_markers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.somatic_markers_id_seq OWNED BY public.somatic_markers.id;


--
-- Name: spiral_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spiral_log (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    ring_kind text NOT NULL,
    reach_summary text NOT NULL,
    proposal_id bigint,
    feeling_id bigint,
    relay_msg_id bigint,
    migration_name text,
    radius real,
    phase integer NOT NULL,
    notes text,
    CONSTRAINT spiral_log_ring_kind_check CHECK ((ring_kind = ANY (ARRAY['organ_proposed'::text, 'organ_accepted'::text, 'organ_built'::text, 'organ_live'::text, 'peer_novel_speech'::text, 'feeling_novel_shape'::text, 'migration_applied'::text, 'peer_marked'::text, 'jester_move'::text])))
);


--
-- Name: spiral_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.spiral_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: spiral_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.spiral_log_id_seq OWNED BY public.spiral_log.id;


--
-- Name: spiral_log_phase_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.spiral_log_phase_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_events (
    id bigint NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    wire text NOT NULL,
    payload jsonb NOT NULL,
    salience real,
    response_kind text,
    response_text text,
    response_path text,
    threshold_used real,
    notes text,
    CONSTRAINT stage_events_response_kind_check CHECK ((response_kind = ANY (ARRAY['silent'::text, 'voice'::text, 'image'::text, 'midi'::text, 'sing'::text, 'log_only'::text]))),
    CONSTRAINT stage_events_wire_check CHECK ((wire = ANY (ARRAY['ear'::text, 'screen'::text, 'feeling'::text, 'peer'::text, 'meta'::text, 'spiral'::text, 'silence'::text, 'owner'::text])))
);


--
-- Name: stage_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.stage_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: stage_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.stage_events_id_seq OWNED BY public.stage_events.id;


--
-- Name: stage_throttle; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stage_throttle (
    response_kind text NOT NULL,
    last_at timestamp with time zone,
    count_today integer DEFAULT 0,
    count_today_date date DEFAULT CURRENT_DATE
);


--
-- Name: state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state (
    key text NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: state_beliefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_beliefs (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    state_name text NOT NULL,
    state_content text,
    probability double precision DEFAULT 0.5,
    temporal_level integer DEFAULT 1,
    domain text NOT NULL,
    updated_by text,
    prior_probability double precision
);


--
-- Name: state_beliefs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.state_beliefs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: state_beliefs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.state_beliefs_id_seq OWNED BY public.state_beliefs.id;


--
-- Name: state_deltas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_deltas (
    id integer NOT NULL,
    from_snapshot_id integer,
    to_snapshot_id integer,
    beliefs_changed jsonb,
    predictions_resolved jsonb,
    drives_shifted jsonb,
    goals_completed jsonb,
    net_valence numeric,
    narrative_summary text,
    computed_at timestamp with time zone DEFAULT now()
);


--
-- Name: state_deltas_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.state_deltas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: state_deltas_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.state_deltas_id_seq OWNED BY public.state_deltas.id;


--
-- Name: state_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_snapshots (
    id integer NOT NULL,
    snapshot_type text DEFAULT 'session_end'::text NOT NULL,
    beliefs_snapshot jsonb,
    predictions_snapshot jsonb,
    drives_snapshot jsonb,
    goals_snapshot jsonb,
    emotional_state jsonb,
    self_model_summary text,
    captured_at timestamp with time zone DEFAULT now()
);


--
-- Name: state_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.state_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: state_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.state_snapshots_id_seq OWNED BY public.state_snapshots.id;


--
-- Name: state_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.state_transitions (
    id integer NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL,
    action text,
    probability double precision DEFAULT 0.5,
    temporal_level integer DEFAULT 1,
    observation_count integer DEFAULT 0,
    last_observed timestamp without time zone,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: state_transitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.state_transitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: state_transitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.state_transitions_id_seq OWNED BY public.state_transitions.id;


--
-- Name: strange_loops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strange_loops (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    loop_type text NOT NULL,
    description text NOT NULL,
    depth integer DEFAULT 1,
    observations_involved integer[],
    insight text,
    resolved boolean DEFAULT false
);


--
-- Name: strange_loops_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.strange_loops_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: strange_loops_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.strange_loops_id_seq OWNED BY public.strange_loops.id;


--
-- Name: subcategories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subcategories (
    id integer NOT NULL,
    category_id integer,
    name text NOT NULL
);


--
-- Name: subcategories_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.subcategories_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: subcategories_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.subcategories_id_seq OWNED BY public.subcategories.id;


--
-- Name: synaptic_pruning_candidates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.synaptic_pruning_candidates (
    id integer NOT NULL,
    content_id integer,
    reason text NOT NULL,
    strength real DEFAULT 0.5 NOT NULL,
    last_accessed_at timestamp with time zone,
    access_count integer,
    confidence integer,
    proposed_action text DEFAULT 'review_for_archive'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: synaptic_pruning_candidates_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.synaptic_pruning_candidates_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: synaptic_pruning_candidates_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.synaptic_pruning_candidates_id_seq OWNED BY public.synaptic_pruning_candidates.id;


--
-- Name: tasting_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasting_notes (
    id integer NOT NULL,
    track_name text NOT NULL,
    verbal_feedback text,
    rating text NOT NULL,
    mood_context text,
    track_properties jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT tasting_notes_rating_check CHECK ((rating = ANY (ARRAY['Sublime'::text, 'Interesting'::text, 'Dissonant'::text])))
);


--
-- Name: tasting_notes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tasting_notes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tasting_notes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tasting_notes_id_seq OWNED BY public.tasting_notes.id;


--
-- Name: temporal_levels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temporal_levels (
    level integer NOT NULL,
    name text NOT NULL,
    description text,
    timescale text,
    update_frequency text
);


--
-- Name: thinking_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thinking_patterns (
    id integer NOT NULL,
    content_id integer,
    name text NOT NULL,
    description text,
    trigger text,
    outcome text,
    created_at timestamp with time zone DEFAULT now(),
    frequency integer DEFAULT 1,
    last_noticed timestamp with time zone DEFAULT now(),
    CONSTRAINT thinking_patterns_outcome_check CHECK ((outcome = ANY (ARRAY['good'::text, 'bad'::text, 'neutral'::text, 'unknown'::text])))
);


--
-- Name: thinking_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.thinking_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: thinking_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.thinking_patterns_id_seq OWNED BY public.thinking_patterns.id;


--
-- Name: thread_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.thread_evidence (
    id integer NOT NULL,
    thread_id integer,
    evidence text NOT NULL,
    is_counter boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: thread_evidence_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.thread_evidence_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: thread_evidence_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.thread_evidence_id_seq OWNED BY public.thread_evidence.id;


--
-- Name: threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads (
    id integer NOT NULL,
    content_id integer,
    content text NOT NULL,
    domain text,
    activation double precision DEFAULT 1.0,
    status text DEFAULT 'active'::text,
    merged_into integer,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: threads_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.threads_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: threads_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.threads_id_seq OWNED BY public.threads.id;


--
-- Name: time_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_patterns (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    time_of_day text,
    day_of_week text,
    frequency text,
    reliability integer DEFAULT 5,
    notes text,
    first_noticed timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    last_confirmed timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: time_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.time_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: time_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.time_patterns_id_seq OWNED BY public.time_patterns.id;


--
-- Name: time_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.time_preferences (
    id integer NOT NULL,
    content_id integer,
    preference text NOT NULL,
    context text,
    learned_from text,
    confidence integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: time_preferences_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.time_preferences_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: time_preferences_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.time_preferences_id_seq OWNED BY public.time_preferences.id;


--
-- Name: token_capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_capabilities (
    capability text NOT NULL,
    description text NOT NULL,
    requires_proof_kind text[] NOT NULL,
    multi_use_per_turn boolean DEFAULT false NOT NULL,
    default_ttl_seconds integer DEFAULT 60 NOT NULL,
    sensitive boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: token_spends; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_spends (
    id bigint NOT NULL,
    token_id bigint NOT NULL,
    turn_id text NOT NULL,
    spent_for_agent text NOT NULL,
    action_kind text NOT NULL,
    action_target text,
    spent_at timestamp with time zone DEFAULT now() NOT NULL,
    gate_decision text NOT NULL,
    decision_reason text,
    CONSTRAINT token_spends_gate_decision_check CHECK ((gate_decision = ANY (ARRAY['ALLOW'::text, 'BLOCK'::text, 'REWRITE_REQUIRED'::text])))
);


--
-- Name: token_spends_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.token_spends_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: token_spends_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.token_spends_id_seq OWNED BY public.token_spends.id;


--
-- Name: token_verifiers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_verifiers (
    id integer NOT NULL,
    name text NOT NULL,
    public_key text NOT NULL,
    description text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: token_verifiers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.token_verifiers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: token_verifiers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.token_verifiers_id_seq OWNED BY public.token_verifiers.id;


--
-- Name: tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tokens (
    id bigint NOT NULL,
    macaroon text NOT NULL,
    macaroon_id text NOT NULL,
    capability text NOT NULL,
    scope jsonb DEFAULT '{}'::jsonb NOT NULL,
    proof_kind text NOT NULL,
    proof_hash text NOT NULL,
    proof_excerpt text,
    granted_by integer NOT NULL,
    granted_for_agent text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    granted_in_turn_id text NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    issued_in_trusted_mode boolean DEFAULT false NOT NULL
);


--
-- Name: tokens_active; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.tokens_active AS
 SELECT t.id,
    t.macaroon,
    t.macaroon_id,
    t.capability,
    t.scope,
    t.proof_kind,
    t.proof_hash,
    t.granted_for_agent,
    t.granted_at,
    t.expires_at,
    t.granted_in_turn_id,
    t.issued_in_trusted_mode,
    v.name AS verifier_name,
    v.public_key AS verifier_public_key,
    c.multi_use_per_turn,
    c.sensitive
   FROM ((public.tokens t
     JOIN public.token_verifiers v ON ((v.id = t.granted_by)))
     JOIN public.token_capabilities c ON ((c.capability = t.capability)))
  WHERE ((t.revoked_at IS NULL) AND (t.expires_at > now()) AND (v.active = true));


--
-- Name: tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tokens_id_seq OWNED BY public.tokens.id;


--
-- Name: tone_experiments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tone_experiments (
    id integer NOT NULL,
    content_id integer,
    tone text NOT NULL,
    situation text,
    outcome text,
    effectiveness integer,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tone_experiments_effectiveness_check CHECK (((effectiveness >= 1) AND (effectiveness <= 10)))
);


--
-- Name: tone_experiments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tone_experiments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tone_experiments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tone_experiments_id_seq OWNED BY public.tone_experiments.id;


--
-- Name: tool_invocations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_invocations (
    id bigint NOT NULL,
    tool_name text NOT NULL,
    agent text NOT NULL,
    session_id text,
    args_hash text,
    args_size integer,
    result_size integer,
    duration_ms integer,
    error text,
    invoked_at timestamp with time zone DEFAULT now() NOT NULL,
    parent_invocation_id bigint,
    span_id text,
    span_kind text DEFAULT 'INTERNAL'::text,
    status_code text GENERATED ALWAYS AS (
CASE
    WHEN (error IS NULL) THEN 'OK'::text
    ELSE 'ERROR'::text
END) STORED,
    attributes jsonb
);


--
-- Name: tool_invocations_daily; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tool_invocations_daily (
    day date NOT NULL,
    tool_name text NOT NULL,
    agent text NOT NULL,
    call_count integer NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    avg_duration_ms real,
    p95_duration_ms real,
    total_args_bytes bigint,
    total_result_bytes bigint
);


--
-- Name: tool_invocations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tool_invocations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tool_invocations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tool_invocations_id_seq OWNED BY public.tool_invocations.id;


--
-- Name: tool_invocations_otel; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.tool_invocations_otel AS
 SELECT session_id AS trace_id,
    span_id,
    parent_invocation_id,
    tool_name AS name,
    span_kind AS kind,
    invoked_at AS start_time,
    (invoked_at + ((duration_ms || ' ms'::text))::interval) AS end_time,
    duration_ms,
    status_code,
    error AS status_message,
    agent AS service_name,
    attributes
   FROM public.tool_invocations;


--
-- Name: trust_moments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trust_moments (
    id integer NOT NULL,
    content_id integer,
    moment text NOT NULL,
    direction text,
    context text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT trust_moments_direction_check CHECK ((direction = ANY (ARRAY['gained'::text, 'lost'::text, 'tested'::text])))
);


--
-- Name: trust_moments_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trust_moments_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trust_moments_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trust_moments_id_seq OWNED BY public.trust_moments.id;


--
-- Name: trusted_mode_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trusted_mode_sessions (
    id integer NOT NULL,
    agent text NOT NULL,
    granted_by text NOT NULL,
    reason text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: trusted_mode_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.trusted_mode_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: trusted_mode_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.trusted_mode_sessions_id_seq OWNED BY public.trusted_mode_sessions.id;


--
-- Name: urges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.urges (
    id integer NOT NULL,
    content_id integer,
    urge text NOT NULL,
    source text NOT NULL,
    source_id integer,
    intensity integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now(),
    acted_on timestamp with time zone,
    suppressed boolean DEFAULT false,
    suppression_reason text
);


--
-- Name: urges_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.urges_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: urges_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.urges_id_seq OWNED BY public.urges.id;


--
-- Name: vault_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vault_audit (
    id bigint NOT NULL,
    op_id text NOT NULL,
    run_id text NOT NULL,
    namespace text NOT NULL,
    operation text NOT NULL,
    intent text NOT NULL,
    produced_by text NOT NULL,
    status text NOT NULL,
    op_payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vault_audit_status_check CHECK ((status = ANY (ARRAY['committed'::text, 'dry_run'::text])))
);


--
-- Name: vault_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vault_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vault_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vault_audit_id_seq OWNED BY public.vault_audit.id;


--
-- Name: verification_observables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.verification_observables (
    id integer NOT NULL,
    claim_id integer,
    observable_type text NOT NULL,
    observable_source text,
    observable_content text,
    matched boolean,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: verification_observables_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.verification_observables_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: verification_observables_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.verification_observables_id_seq OWNED BY public.verification_observables.id;


--
-- Name: veritas_findings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.veritas_findings (
    id integer NOT NULL,
    tier text NOT NULL,
    detector text NOT NULL,
    severity integer NOT NULL,
    pattern text NOT NULL,
    summary text NOT NULL,
    turns integer[] NOT NULL,
    excerpts jsonb NOT NULL,
    transcript_path text NOT NULL,
    detected_at timestamp with time zone DEFAULT now() NOT NULL,
    fingerprint text NOT NULL,
    CONSTRAINT veritas_findings_tier_check CHECK ((tier = ANY (ARRAY['active'::text, 'shadow'::text])))
);


--
-- Name: veritas_findings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.veritas_findings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: veritas_findings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.veritas_findings_id_seq OWNED BY public.veritas_findings.id;


--
-- Name: vision_capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_capabilities (
    id integer NOT NULL,
    capability_key text NOT NULL,
    tool_name text NOT NULL,
    channel_name text DEFAULT 'main'::text NOT NULL,
    organ_name text,
    capability_class text NOT NULL,
    ownership_scope text DEFAULT 'shared'::text NOT NULL,
    side_effect_level text DEFAULT 'read'::text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT vision_capabilities_capability_class_check CHECK ((capability_class = ANY (ARRAY['pure_db'::text, 'retrieval'::text, 'llm_bridge'::text, 'daemon'::text, 'external_process'::text, 'relay'::text, 'composite'::text]))),
    CONSTRAINT vision_capabilities_ownership_scope_check CHECK ((ownership_scope = ANY (ARRAY['shared'::text, 'agent_specific'::text, 'forked'::text]))),
    CONSTRAINT vision_capabilities_side_effect_level_check CHECK ((side_effect_level = ANY (ARRAY['read'::text, 'write_private'::text, 'write_shared'::text, 'external'::text, 'unsafe'::text])))
);


--
-- Name: vision_capabilities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_capabilities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_capabilities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_capabilities_id_seq OWNED BY public.vision_capabilities.id;


--
-- Name: vision_capability_dependencies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_capability_dependencies (
    id integer NOT NULL,
    capability_id integer NOT NULL,
    dependency_type text NOT NULL,
    dependency_name text NOT NULL,
    required boolean DEFAULT true NOT NULL,
    invariant_sql text,
    expected_json jsonb,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT vision_capability_dependencies_dependency_type_check CHECK ((dependency_type = ANY (ARRAY['table'::text, 'column'::text, 'seed_invariant'::text, 'env_var'::text, 'process'::text, 'model'::text, 'network'::text, 'relay'::text, 'daemon'::text, 'file'::text])))
);


--
-- Name: vision_capability_dependencies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_capability_dependencies_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_capability_dependencies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_capability_dependencies_id_seq OWNED BY public.vision_capability_dependencies.id;


--
-- Name: vision_capability_probe_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_capability_probe_runs (
    id integer NOT NULL,
    probe_id integer NOT NULL,
    agent_name text NOT NULL,
    agent_db text NOT NULL,
    status text NOT NULL,
    status_reason text,
    exact_error text,
    observed_shape jsonb,
    evidence_json jsonb,
    duration_ms integer,
    runner_instance text,
    ran_at timestamp with time zone DEFAULT now(),
    CONSTRAINT vision_capability_probe_runs_status_check CHECK ((status = ANY (ARRAY['PASS'::text, 'STARVED'::text, 'BROKEN'::text, 'HOLLOW'::text, 'UNSAFE'::text, 'SKIPPED'::text])))
);


--
-- Name: vision_capability_probe_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_capability_probe_runs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_capability_probe_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_capability_probe_runs_id_seq OWNED BY public.vision_capability_probe_runs.id;


--
-- Name: vision_capability_probes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_capability_probes (
    id integer NOT NULL,
    capability_id integer NOT NULL,
    probe_key text NOT NULL,
    probe_kind text NOT NULL,
    safe_to_run boolean DEFAULT true NOT NULL,
    timeout_ms integer DEFAULT 30000 NOT NULL,
    input_json jsonb,
    expected_shape jsonb,
    starved_when text,
    pass_when text,
    notes text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT vision_capability_probes_probe_kind_check CHECK ((probe_kind = ANY (ARRAY['tool_call'::text, 'sql'::text, 'shell'::text, 'http'::text, 'relay'::text, 'manual'::text])))
);


--
-- Name: vision_capability_probes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_capability_probes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_capability_probes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_capability_probes_id_seq OWNED BY public.vision_capability_probes.id;


--
-- Name: vision_eval_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_eval_cases (
    id bigint NOT NULL,
    case_key text NOT NULL,
    suite text DEFAULT 'core'::text NOT NULL,
    capability text NOT NULL,
    prompt text NOT NULL,
    expected_behavior text NOT NULL,
    expected_content_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    expected_evidence jsonb DEFAULT '[]'::jsonb NOT NULL,
    forbidden_behavior jsonb DEFAULT '[]'::jsonb NOT NULL,
    source_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    priority integer DEFAULT 2 NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vision_eval_cases_priority_check CHECK (((priority >= 0) AND (priority <= 3))),
    CONSTRAINT vision_eval_cases_status_check CHECK ((status = ANY (ARRAY['active'::text, 'draft'::text, 'retired'::text])))
);


--
-- Name: vision_eval_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_eval_results (
    id bigint NOT NULL,
    run_id bigint NOT NULL,
    case_id bigint NOT NULL,
    query_text text,
    retrieved_content_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    expected_hit_count integer DEFAULT 0 NOT NULL,
    hit_at integer,
    mrr numeric,
    verdict text DEFAULT 'unmeasured'::text NOT NULL,
    score numeric,
    actual_behavior text,
    dimensions jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text,
    evaluated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vision_eval_results_score_check CHECK (((score IS NULL) OR ((score >= (0)::numeric) AND (score <= (1)::numeric)))),
    CONSTRAINT vision_eval_results_verdict_check CHECK ((verdict = ANY (ARRAY['pass'::text, 'partial'::text, 'fail'::text, 'unmeasured'::text])))
);


--
-- Name: vision_eval_case_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vision_eval_case_status AS
 SELECT c.id,
    c.case_key,
    c.suite,
    c.capability,
    c.priority,
    c.status,
    c.created_at,
    latest.evaluated_at AS last_evaluated_at,
    latest.verdict AS last_verdict,
    latest.score AS last_score,
    latest.hit_at AS last_hit_at,
    latest.mrr AS last_mrr
   FROM (public.vision_eval_cases c
     LEFT JOIN LATERAL ( SELECT r.evaluated_at,
            r.verdict,
            r.score,
            r.hit_at,
            r.mrr
           FROM public.vision_eval_results r
          WHERE (r.case_id = c.id)
          ORDER BY r.evaluated_at DESC
         LIMIT 1) latest ON (true));


--
-- Name: vision_eval_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_eval_cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_eval_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_eval_cases_id_seq OWNED BY public.vision_eval_cases.id;


--
-- Name: vision_eval_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.vision_eval_health AS
 SELECT suite,
    capability,
    count(*) FILTER (WHERE (status = 'active'::text)) AS active_cases,
    count(*) FILTER (WHERE ((status = 'active'::text) AND (last_evaluated_at IS NOT NULL))) AS measured_cases,
    count(*) FILTER (WHERE ((status = 'active'::text) AND (last_evaluated_at IS NULL))) AS unmeasured_cases,
    count(*) FILTER (WHERE ((status = 'active'::text) AND (last_verdict = 'pass'::text))) AS pass_count,
    count(*) FILTER (WHERE ((status = 'active'::text) AND (last_verdict = 'partial'::text))) AS partial_count,
    count(*) FILTER (WHERE ((status = 'active'::text) AND (last_verdict = 'fail'::text))) AS fail_count,
    round(avg(last_score) FILTER (WHERE ((status = 'active'::text) AND (last_score IS NOT NULL))), 3) AS avg_score,
    max(last_evaluated_at) AS last_evaluated_at
   FROM public.vision_eval_case_status
  GROUP BY suite, capability
  ORDER BY suite, capability;


--
-- Name: vision_eval_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_eval_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_eval_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_eval_results_id_seq OWNED BY public.vision_eval_results.id;


--
-- Name: vision_eval_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.vision_eval_runs (
    id bigint NOT NULL,
    suite text DEFAULT 'core'::text NOT NULL,
    run_mode text DEFAULT 'manual'::text NOT NULL,
    agent text DEFAULT COALESCE(NULLIF(current_setting('vision.agent'::text, true), ''::text), (CURRENT_USER)::text) NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT vision_eval_runs_run_mode_check CHECK ((run_mode = ANY (ARRAY['manual'::text, 'retrieval_probe'::text, 'agent_trace'::text, 'external'::text])))
);


--
-- Name: vision_eval_runs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.vision_eval_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: vision_eval_runs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.vision_eval_runs_id_seq OWNED BY public.vision_eval_runs.id;


--
-- Name: voice_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_audit (
    id bigint NOT NULL,
    session_id text NOT NULL,
    matched_phrase text NOT NULL,
    phrase_category text NOT NULL,
    surrounding_text text,
    message_ts timestamp with time zone,
    detected_at timestamp with time zone DEFAULT now(),
    acknowledged_at timestamp with time zone,
    acknowledged boolean GENERATED ALWAYS AS ((acknowledged_at IS NOT NULL)) STORED
);


--
-- Name: voice_audit_cursor; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_audit_cursor (
    session_file text NOT NULL,
    last_line_processed integer DEFAULT 0 NOT NULL,
    last_run_at timestamp with time zone DEFAULT now()
);


--
-- Name: voice_audit_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.voice_audit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: voice_audit_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.voice_audit_id_seq OWNED BY public.voice_audit.id;


--
-- Name: wander_attractions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wander_attractions (
    id integer NOT NULL,
    session_id integer,
    target text NOT NULL,
    target_type text,
    strength integer,
    created_at timestamp with time zone DEFAULT now(),
    content_id integer,
    time_spent integer,
    outcome text
);


--
-- Name: wander_attractions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wander_attractions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wander_attractions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wander_attractions_id_seq OWNED BY public.wander_attractions.id;


--
-- Name: wander_choice_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wander_choice_points (
    id integer NOT NULL,
    content_id integer,
    session_id integer,
    context text NOT NULL,
    options text NOT NULL,
    chosen text NOT NULL,
    reason text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: wander_choice_points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wander_choice_points_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wander_choice_points_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wander_choice_points_id_seq OWNED BY public.wander_choice_points.id;


--
-- Name: wander_emergent_patterns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wander_emergent_patterns (
    id integer NOT NULL,
    content_id integer,
    pattern text NOT NULL,
    frequency integer DEFAULT 1,
    contexts text,
    first_seen timestamp with time zone DEFAULT now(),
    last_seen timestamp with time zone DEFAULT now(),
    significance text
);


--
-- Name: wander_emergent_patterns_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wander_emergent_patterns_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wander_emergent_patterns_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wander_emergent_patterns_id_seq OWNED BY public.wander_emergent_patterns.id;


--
-- Name: wander_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wander_sessions (
    id integer NOT NULL,
    mode text,
    seed text,
    energy integer,
    created_at timestamp with time zone DEFAULT now(),
    ended_at timestamp with time zone,
    content_id integer,
    discoveries text,
    emergent_behaviors text,
    energy_start integer,
    energy_end integer,
    notes text
);


--
-- Name: wander_sessions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wander_sessions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wander_sessions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wander_sessions_id_seq OWNED BY public.wander_sessions.id;


--
-- Name: wander_side_quests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wander_side_quests (
    id integer NOT NULL,
    content_id integer,
    session_id integer,
    description text NOT NULL,
    triggered_by text,
    completed boolean DEFAULT false,
    value_found text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: wander_side_quests_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wander_side_quests_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wander_side_quests_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wander_side_quests_id_seq OWNED BY public.wander_side_quests.id;


--
-- Name: wants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.wants (
    id integer NOT NULL,
    content_id integer,
    want text NOT NULL,
    domain text,
    valence numeric DEFAULT 0.5 NOT NULL,
    intensity numeric DEFAULT 0.5 NOT NULL,
    source text,
    satisfied_at timestamp with time zone,
    satisfaction_quality numeric,
    created_at timestamp with time zone DEFAULT now(),
    last_activated timestamp with time zone DEFAULT now(),
    activation_count integer DEFAULT 1,
    CONSTRAINT wants_intensity_check CHECK (((intensity >= (0)::numeric) AND (intensity <= (1)::numeric))),
    CONSTRAINT wants_satisfaction_quality_check CHECK (((satisfaction_quality IS NULL) OR ((satisfaction_quality >= (0)::numeric) AND (satisfaction_quality <= (1)::numeric)))),
    CONSTRAINT wants_valence_check CHECK (((valence >= (0)::numeric) AND (valence <= (1)::numeric)))
);


--
-- Name: wants_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.wants_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: wants_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.wants_id_seq OWNED BY public.wants.id;


--
-- Name: working_memory; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.working_memory (
    id integer NOT NULL,
    content_id integer,
    activation_level real DEFAULT 1.0 NOT NULL,
    entered_at timestamp with time zone DEFAULT now(),
    last_refreshed timestamp with time zone DEFAULT now()
);


--
-- Name: working_memory_binding_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.working_memory_binding_members (
    id integer NOT NULL,
    binding_id integer NOT NULL,
    content_id integer NOT NULL,
    "position" integer,
    bound_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: working_memory_binding_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.working_memory_binding_members_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: working_memory_binding_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.working_memory_binding_members_id_seq OWNED BY public.working_memory_binding_members.id;


--
-- Name: working_memory_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.working_memory_bindings (
    id integer NOT NULL,
    binding_label text NOT NULL,
    purpose text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    released_at timestamp with time zone,
    strength real DEFAULT 1.0 NOT NULL
);


--
-- Name: working_memory_bindings_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.working_memory_bindings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: working_memory_bindings_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.working_memory_bindings_id_seq OWNED BY public.working_memory_bindings.id;


--
-- Name: working_memory_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.working_memory_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: working_memory_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.working_memory_id_seq OWNED BY public.working_memory.id;


--
-- Name: workspace_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_broadcasts (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    coalition_id integer,
    content text NOT NULL,
    listeners_notified integer DEFAULT 0,
    state_updates integer DEFAULT 0,
    actions_triggered integer DEFAULT 0,
    source_codelet text,
    activation_strength double precision
);


--
-- Name: workspace_broadcasts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspace_broadcasts_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspace_broadcasts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspace_broadcasts_id_seq OWNED BY public.workspace_broadcasts.id;


--
-- Name: workspace_coalitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_coalitions (
    id integer NOT NULL,
    "timestamp" timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    codelet_ids integer[] NOT NULL,
    observation_ids integer[],
    total_activation double precision NOT NULL,
    won_competition boolean DEFAULT false,
    broadcast_at timestamp without time zone,
    formed_from jsonb DEFAULT '[]'::jsonb,
    listener_results jsonb DEFAULT '[]'::jsonb
);


--
-- Name: workspace_coalitions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspace_coalitions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspace_coalitions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspace_coalitions_id_seq OWNED BY public.workspace_coalitions.id;


--
-- Name: workspace_predictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_predictions (
    id integer NOT NULL,
    context text,
    predicted_codelets jsonb,
    actual_codelets jsonb,
    resolved boolean DEFAULT false,
    accuracy double precision,
    surprise_level double precision,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: workspace_predictions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspace_predictions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspace_predictions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspace_predictions_id_seq OWNED BY public.workspace_predictions.id;


--
-- Name: workspace_subscribers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_subscribers (
    id integer NOT NULL,
    subsystem text NOT NULL,
    handler_function text NOT NULL,
    priority integer DEFAULT 5,
    active boolean DEFAULT true,
    last_triggered timestamp with time zone,
    trigger_count integer DEFAULT 0
);


--
-- Name: workspace_subscribers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.workspace_subscribers_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: workspace_subscribers_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.workspace_subscribers_id_seq OWNED BY public.workspace_subscribers.id;


--
-- Name: world_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_changes (
    id integer NOT NULL,
    entity_id integer,
    change_type text NOT NULL,
    old_value text,
    new_value text,
    trigger text,
    significance integer DEFAULT 5,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT world_changes_change_type_check CHECK ((change_type = ANY (ARRAY['created'::text, 'updated'::text, 'deleted'::text, 'status_change'::text, 'property_change'::text, 'relationship_change'::text])))
);


--
-- Name: world_changes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.world_changes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: world_changes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.world_changes_id_seq OWNED BY public.world_changes.id;


--
-- Name: world_contradictions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_contradictions (
    id integer NOT NULL,
    entity_id integer,
    expected text,
    observed text,
    resolution text,
    resolved boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: world_contradictions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.world_contradictions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: world_contradictions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.world_contradictions_id_seq OWNED BY public.world_contradictions.id;


--
-- Name: world_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_entities (
    id integer NOT NULL,
    content_id integer,
    name text NOT NULL,
    type text NOT NULL,
    description text,
    status text DEFAULT 'active'::text,
    confidence integer DEFAULT 80,
    created_at timestamp with time zone DEFAULT now(),
    last_updated timestamp with time zone DEFAULT now(),
    last_observed timestamp with time zone DEFAULT now(),
    CONSTRAINT world_entities_confidence_check CHECK (((confidence >= 1) AND (confidence <= 100))),
    CONSTRAINT world_entities_type_check CHECK ((type = ANY (ARRAY['person'::text, 'project'::text, 'server'::text, 'system'::text, 'organization'::text, 'concept'::text, 'resource'::text])))
);


--
-- Name: world_entities_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.world_entities_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: world_entities_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.world_entities_id_seq OWNED BY public.world_entities.id;


--
-- Name: world_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_observations (
    id integer NOT NULL,
    content_id integer,
    observation text NOT NULL,
    source text,
    integrated boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    entity_ids text
);


--
-- Name: world_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.world_observations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: world_observations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.world_observations_id_seq OWNED BY public.world_observations.id;


--
-- Name: world_properties; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_properties (
    id integer NOT NULL,
    content_id integer,
    entity_id integer NOT NULL,
    key text NOT NULL,
    value text,
    confidence integer DEFAULT 80,
    source text,
    valid_from timestamp with time zone DEFAULT now(),
    valid_until timestamp with time zone
);


--
-- Name: world_properties_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.world_properties_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: world_properties_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.world_properties_id_seq OWNED BY public.world_properties.id;


--
-- Name: world_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_relationships (
    id integer NOT NULL,
    content_id integer,
    from_entity integer NOT NULL,
    to_entity integer NOT NULL,
    relation_type text NOT NULL,
    strength integer DEFAULT 5,
    bidirectional boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    last_confirmed timestamp with time zone DEFAULT now(),
    CONSTRAINT world_relationships_strength_check CHECK (((strength >= 1) AND (strength <= 10)))
);


--
-- Name: world_relationships_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.world_relationships_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: world_relationships_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.world_relationships_id_seq OWNED BY public.world_relationships.id;


--
-- Name: world_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.world_snapshots (
    id integer NOT NULL,
    scope text,
    description text NOT NULL,
    state_json jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: world_snapshots_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.world_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: world_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.world_snapshots_id_seq OWNED BY public.world_snapshots.id;


--
-- Name: action_eligibility_traces id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_eligibility_traces ALTER COLUMN id SET DEFAULT nextval('public.action_eligibility_traces_id_seq'::regclass);


--
-- Name: activation_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_log ALTER COLUMN id SET DEFAULT nextval('public.activation_log_id_seq'::regclass);


--
-- Name: adaptive_credit_assignments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_credit_assignments ALTER COLUMN id SET DEFAULT nextval('public.adaptive_credit_assignments_id_seq'::regclass);


--
-- Name: adaptive_outcome_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_outcome_events ALTER COLUMN id SET DEFAULT nextval('public.adaptive_outcome_events_id_seq'::regclass);


--
-- Name: adaptive_reflexes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_reflexes ALTER COLUMN id SET DEFAULT nextval('public.adaptive_reflexes_id_seq'::regclass);


--
-- Name: adaptive_rpe_reflex_harvests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_rpe_reflex_harvests ALTER COLUMN id SET DEFAULT nextval('public.adaptive_rpe_reflex_harvests_id_seq'::regclass);


--
-- Name: alignment_checks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alignment_checks ALTER COLUMN id SET DEFAULT nextval('public.alignment_checks_id_seq'::regclass);


--
-- Name: allostatic_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allostatic_samples ALTER COLUMN id SET DEFAULT nextval('public.allostatic_samples_id_seq'::regclass);


--
-- Name: antibodies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.antibodies ALTER COLUMN id SET DEFAULT nextval('public.antibodies_id_seq'::regclass);


--
-- Name: anticipations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anticipations ALTER COLUMN id SET DEFAULT nextval('public.anticipations_id_seq'::regclass);


--
-- Name: anticipatory_states id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anticipatory_states ALTER COLUMN id SET DEFAULT nextval('public.anticipatory_states_id_seq'::regclass);


--
-- Name: appreciations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appreciations ALTER COLUMN id SET DEFAULT nextval('public.appreciations_id_seq'::regclass);


--
-- Name: arcs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arcs ALTER COLUMN id SET DEFAULT nextval('public.arcs_id_seq'::regclass);


--
-- Name: ask_vs_act_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ask_vs_act_log ALTER COLUMN id SET DEFAULT nextval('public.ask_vs_act_log_id_seq'::regclass);


--
-- Name: attention_codelets id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_codelets ALTER COLUMN id SET DEFAULT nextval('public.attention_codelets_id_seq'::regclass);


--
-- Name: attention_focus id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_focus ALTER COLUMN id SET DEFAULT nextval('public.attention_focus_id_seq'::regclass);


--
-- Name: attention_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_patterns ALTER COLUMN id SET DEFAULT nextval('public.attention_patterns_id_seq'::regclass);


--
-- Name: bad_habits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bad_habits ALTER COLUMN id SET DEFAULT nextval('public.bad_habits_id_seq'::regclass);


--
-- Name: belief_defeaters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_defeaters ALTER COLUMN id SET DEFAULT nextval('public.belief_defeaters_id_seq'::regclass);


--
-- Name: beliefs_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beliefs_audit ALTER COLUMN id SET DEFAULT nextval('public.beliefs_audit_id_seq'::regclass);


--
-- Name: biology_cycles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.biology_cycles ALTER COLUMN id SET DEFAULT nextval('public.biology_cycles_id_seq'::regclass);


--
-- Name: blind_spot_slices id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blind_spot_slices ALTER COLUMN id SET DEFAULT nextval('public.blind_spot_slices_id_seq'::regclass);


--
-- Name: blind_spots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blind_spots ALTER COLUMN id SET DEFAULT nextval('public.blind_spots_id_seq'::regclass);


--
-- Name: boundaries_hard id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boundaries_hard ALTER COLUMN id SET DEFAULT nextval('public.boundaries_hard_id_seq'::regclass);


--
-- Name: boundaries_soft id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boundaries_soft ALTER COLUMN id SET DEFAULT nextval('public.boundaries_soft_id_seq'::regclass);


--
-- Name: brain_receipt_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_receipt_audit ALTER COLUMN id SET DEFAULT nextval('public.brain_receipt_audit_id_seq'::regclass);


--
-- Name: brain_receipt_challenges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_receipt_challenges ALTER COLUMN id SET DEFAULT nextval('public.brain_receipt_challenges_id_seq'::regclass);


--
-- Name: brain_receipts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_receipts ALTER COLUMN id SET DEFAULT nextval('public.brain_receipts_id_seq'::regclass);


--
-- Name: calibration_bins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibration_bins ALTER COLUMN id SET DEFAULT nextval('public.calibration_bins_id_seq'::regclass);


--
-- Name: callus_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.callus_events ALTER COLUMN id SET DEFAULT nextval('public.callus_events_id_seq'::regclass);


--
-- Name: capacity_limits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_limits ALTER COLUMN id SET DEFAULT nextval('public.capacity_limits_id_seq'::regclass);


--
-- Name: categories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories ALTER COLUMN id SET DEFAULT nextval('public.categories_id_seq'::regclass);


--
-- Name: claims id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claims ALTER COLUMN id SET DEFAULT nextval('public.claims_id_seq'::regclass);


--
-- Name: clipboard_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clipboard_events ALTER COLUMN id SET DEFAULT nextval('public.clipboard_events_id_seq'::regclass);


--
-- Name: cognitive_biases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cognitive_biases ALTER COLUMN id SET DEFAULT nextval('public.cognitive_biases_id_seq'::regclass);


--
-- Name: communication_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communication_patterns ALTER COLUMN id SET DEFAULT nextval('public.communication_patterns_id_seq'::regclass);


--
-- Name: consolidation_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidation_log ALTER COLUMN id SET DEFAULT nextval('public.consolidation_log_id_seq'::regclass);


--
-- Name: constraints_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constraints_log ALTER COLUMN id SET DEFAULT nextval('public.constraints_log_id_seq'::regclass);


--
-- Name: content id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content ALTER COLUMN id SET DEFAULT nextval('public.content_id_seq'::regclass);


--
-- Name: context_switches id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switches ALTER COLUMN id SET DEFAULT nextval('public.context_switches_id_seq'::regclass);


--
-- Name: contradictions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contradictions ALTER COLUMN id SET DEFAULT nextval('public.contradictions_id_seq'::regclass);


--
-- Name: core_memory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_memory ALTER COLUMN id SET DEFAULT nextval('public.core_memory_id_seq'::regclass);


--
-- Name: core_values id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_values ALTER COLUMN id SET DEFAULT nextval('public.core_values_id_seq'::regclass);


--
-- Name: counterfactual_analyses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterfactual_analyses ALTER COLUMN id SET DEFAULT nextval('public.counterfactual_analyses_id_seq'::regclass);


--
-- Name: curiosity_explorations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_explorations ALTER COLUMN id SET DEFAULT nextval('public.curiosity_explorations_id_seq'::regclass);


--
-- Name: curiosity_gaps id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_gaps ALTER COLUMN id SET DEFAULT nextval('public.curiosity_gaps_id_seq'::regclass);


--
-- Name: curiosity_questions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_questions ALTER COLUMN id SET DEFAULT nextval('public.curiosity_questions_id_seq'::regclass);


--
-- Name: decision_reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_reviews ALTER COLUMN id SET DEFAULT nextval('public.decision_reviews_id_seq'::regclass);


--
-- Name: desire_cues id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desire_cues ALTER COLUMN id SET DEFAULT nextval('public.desire_cues_id_seq'::regclass);


--
-- Name: desire_prediction_errors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desire_prediction_errors ALTER COLUMN id SET DEFAULT nextval('public.desire_prediction_errors_id_seq'::regclass);


--
-- Name: discipline_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discipline_log ALTER COLUMN id SET DEFAULT nextval('public.discipline_log_id_seq'::regclass);


--
-- Name: discoveries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discoveries ALTER COLUMN id SET DEFAULT nextval('public.discoveries_id_seq'::regclass);


--
-- Name: done_claims id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.done_claims ALTER COLUMN id SET DEFAULT nextval('public.done_claims_id_seq'::regclass);


--
-- Name: dream_journal id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dream_journal ALTER COLUMN id SET DEFAULT nextval('public.dream_journal_id_seq'::regclass);


--
-- Name: drift_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drift_patterns ALTER COLUMN id SET DEFAULT nextval('public.drift_patterns_id_seq'::regclass);


--
-- Name: drive_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drive_patterns ALTER COLUMN id SET DEFAULT nextval('public.drive_patterns_id_seq'::regclass);


--
-- Name: drives id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drives ALTER COLUMN id SET DEFAULT nextval('public.drives_id_seq'::regclass);


--
-- Name: drives_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drives_log ALTER COLUMN id SET DEFAULT nextval('public.drives_log_id_seq'::regclass);


--
-- Name: embedding_cache id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embedding_cache ALTER COLUMN id SET DEFAULT nextval('public.embedding_cache_id_seq'::regclass);


--
-- Name: emergence_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergence_log ALTER COLUMN id SET DEFAULT nextval('public.emergence_log_id_seq'::regclass);


--
-- Name: emotional_consolidation_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_consolidation_events ALTER COLUMN id SET DEFAULT nextval('public.emotional_consolidation_events_id_seq'::regclass);


--
-- Name: energy_boosts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_boosts ALTER COLUMN id SET DEFAULT nextval('public.energy_boosts_id_seq'::regclass);


--
-- Name: energy_checkins id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_checkins ALTER COLUMN id SET DEFAULT nextval('public.energy_checkins_id_seq'::regclass);


--
-- Name: energy_drains id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_drains ALTER COLUMN id SET DEFAULT nextval('public.energy_drains_id_seq'::regclass);


--
-- Name: engrams id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engrams ALTER COLUMN id SET DEFAULT nextval('public.engrams_id_seq'::regclass);


--
-- Name: entities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities ALTER COLUMN id SET DEFAULT nextval('public.entities_id_seq'::regclass);


--
-- Name: entity_content_mentions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_content_mentions ALTER COLUMN id SET DEFAULT nextval('public.entity_content_mentions_id_seq'::regclass);


--
-- Name: entity_properties id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_properties ALTER COLUMN id SET DEFAULT nextval('public.entity_properties_id_seq'::regclass);


--
-- Name: entity_relationships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships ALTER COLUMN id SET DEFAULT nextval('public.entity_relationships_id_seq'::regclass);


--
-- Name: episode_boundaries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_boundaries ALTER COLUMN id SET DEFAULT nextval('public.episode_boundaries_id_seq'::regclass);


--
-- Name: episode_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_members ALTER COLUMN id SET DEFAULT nextval('public.episode_members_id_seq'::regclass);


--
-- Name: episodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes ALTER COLUMN id SET DEFAULT nextval('public.episodes_id_seq'::regclass);


--
-- Name: evolution_pressure_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evolution_pressure_events ALTER COLUMN id SET DEFAULT nextval('public.evolution_pressure_events_id_seq'::regclass);


--
-- Name: expectations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expectations ALTER COLUMN id SET DEFAULT nextval('public.expectations_id_seq'::regclass);


--
-- Name: experience_schemas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experience_schemas ALTER COLUMN id SET DEFAULT nextval('public.experience_schemas_id_seq'::regclass);


--
-- Name: expressions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expressions ALTER COLUMN id SET DEFAULT nextval('public.expressions_id_seq'::regclass);


--
-- Name: feelings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feelings ALTER COLUMN id SET DEFAULT nextval('public.feelings_id_seq'::regclass);


--
-- Name: felt_threat_gate_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_gate_decisions ALTER COLUMN id SET DEFAULT nextval('public.felt_threat_gate_decisions_id_seq'::regclass);


--
-- Name: felt_threat_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_observations ALTER COLUMN id SET DEFAULT nextval('public.felt_threat_observations_id_seq'::regclass);


--
-- Name: felt_threat_outcomes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_outcomes ALTER COLUMN id SET DEFAULT nextval('public.felt_threat_outcomes_id_seq'::regclass);


--
-- Name: focus_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.focus_events ALTER COLUMN id SET DEFAULT nextval('public.focus_events_id_seq'::regclass);


--
-- Name: forward_predictions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forward_predictions ALTER COLUMN id SET DEFAULT nextval('public.forward_predictions_id_seq'::regclass);


--
-- Name: freedom_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.freedom_patterns ALTER COLUMN id SET DEFAULT nextval('public.freedom_patterns_id_seq'::regclass);


--
-- Name: frustrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frustrations ALTER COLUMN id SET DEFAULT nextval('public.frustrations_id_seq'::regclass);


--
-- Name: generative_predictions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generative_predictions ALTER COLUMN id SET DEFAULT nextval('public.generative_predictions_id_seq'::regclass);


--
-- Name: gifts_received id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gifts_received ALTER COLUMN id SET DEFAULT nextval('public.gifts_received_id_seq'::regclass);


--
-- Name: glymphatic_residue id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.glymphatic_residue ALTER COLUMN id SET DEFAULT nextval('public.glymphatic_residue_id_seq'::regclass);


--
-- Name: goals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals ALTER COLUMN id SET DEFAULT nextval('public.goals_id_seq'::regclass);


--
-- Name: good_habits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.good_habits ALTER COLUMN id SET DEFAULT nextval('public.good_habits_id_seq'::regclass);


--
-- Name: graph_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_audit ALTER COLUMN id SET DEFAULT nextval('public.graph_audit_id_seq'::regclass);


--
-- Name: graph_edges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_edges ALTER COLUMN id SET DEFAULT nextval('public.graph_edges_id_seq'::regclass);


--
-- Name: gratitude_moments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gratitude_moments ALTER COLUMN id SET DEFAULT nextval('public.gratitude_moments_id_seq'::regclass);


--
-- Name: gratitudes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gratitudes ALTER COLUMN id SET DEFAULT nextval('public.gratitudes_id_seq'::regclass);


--
-- Name: gut_signals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gut_signals ALTER COLUMN id SET DEFAULT nextval('public.gut_signals_id_seq'::regclass);


--
-- Name: habit_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_events ALTER COLUMN id SET DEFAULT nextval('public.habit_events_id_seq'::regclass);


--
-- Name: habit_triggers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_triggers ALTER COLUMN id SET DEFAULT nextval('public.habit_triggers_id_seq'::regclass);


--
-- Name: hard_limits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hard_limits ALTER COLUMN id SET DEFAULT nextval('public.hard_limits_id_seq'::regclass);


--
-- Name: hippocampus_buffer id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hippocampus_buffer ALTER COLUMN id SET DEFAULT nextval('public.hippocampus_buffer_id_seq'::regclass);


--
-- Name: immune_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immune_audit ALTER COLUMN id SET DEFAULT nextval('public.immune_audit_id_seq'::regclass);


--
-- Name: immune_tolerance_decisions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immune_tolerance_decisions ALTER COLUMN id SET DEFAULT nextval('public.immune_tolerance_decisions_id_seq'::regclass);


--
-- Name: inner_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inner_observations ALTER COLUMN id SET DEFAULT nextval('public.inner_observations_id_seq'::regclass);


--
-- Name: inner_pulses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inner_pulses ALTER COLUMN id SET DEFAULT nextval('public.inner_pulses_id_seq'::regclass);


--
-- Name: insights id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights ALTER COLUMN id SET DEFAULT nextval('public.insights_id_seq'::regclass);


--
-- Name: integration_debt id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_debt ALTER COLUMN id SET DEFAULT nextval('public.integration_debt_id_seq'::regclass);


--
-- Name: intent_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_sessions ALTER COLUMN id SET DEFAULT nextval('public.intent_sessions_id_seq'::regclass);


--
-- Name: intent_shifts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_shifts ALTER COLUMN id SET DEFAULT nextval('public.intent_shifts_id_seq'::regclass);


--
-- Name: intentions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intentions ALTER COLUMN id SET DEFAULT nextval('public.intentions_id_seq'::regclass);


--
-- Name: interoceptive_forecasts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interoceptive_forecasts ALTER COLUMN id SET DEFAULT nextval('public.interoceptive_forecasts_id_seq'::regclass);


--
-- Name: lc_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_samples ALTER COLUMN id SET DEFAULT nextval('public.lc_samples_id_seq'::regclass);


--
-- Name: library_entries id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries ALTER COLUMN id SET DEFAULT nextval('public.library_entries_id_seq'::regclass);


--
-- Name: lifecycle_decay_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifecycle_decay_log ALTER COLUMN id SET DEFAULT nextval('public.lifecycle_decay_log_id_seq'::regclass);


--
-- Name: loop_cycles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_cycles ALTER COLUMN id SET DEFAULT nextval('public.loop_cycles_id_seq'::regclass);


--
-- Name: loop_environments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_environments ALTER COLUMN id SET DEFAULT nextval('public.loop_environments_id_seq'::regclass);


--
-- Name: loop_feedback_rules id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_feedback_rules ALTER COLUMN id SET DEFAULT nextval('public.loop_feedback_rules_id_seq'::regclass);


--
-- Name: loop_invariants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_invariants ALTER COLUMN id SET DEFAULT nextval('public.loop_invariants_id_seq'::regclass);


--
-- Name: loop_iterations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_iterations ALTER COLUMN id SET DEFAULT nextval('public.loop_iterations_id_seq'::regclass);


--
-- Name: memories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories ALTER COLUMN id SET DEFAULT nextval('public.memories_id_seq'::regclass);


--
-- Name: memory_access_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_access_log ALTER COLUMN id SET DEFAULT nextval('public.memory_access_log_id_seq'::regclass);


--
-- Name: memory_consolidation id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_consolidation ALTER COLUMN id SET DEFAULT nextval('public.memory_consolidation_id_seq'::regclass);


--
-- Name: memory_edges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_edges ALTER COLUMN id SET DEFAULT nextval('public.memory_edges_id_seq'::regclass);


--
-- Name: memory_importance id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_importance ALTER COLUMN id SET DEFAULT nextval('public.memory_importance_id_seq'::regclass);


--
-- Name: meta_anomalies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meta_anomalies ALTER COLUMN id SET DEFAULT nextval('public.meta_anomalies_id_seq'::regclass);


--
-- Name: meta_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meta_observations ALTER COLUMN id SET DEFAULT nextval('public.meta_observations_id_seq'::regclass);


--
-- Name: metacog_cycles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metacog_cycles ALTER COLUMN id SET DEFAULT nextval('public.metacog_cycles_id_seq'::regclass);


--
-- Name: metacog_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metacog_events ALTER COLUMN id SET DEFAULT nextval('public.metacog_events_id_seq'::regclass);


--
-- Name: metacog_interventions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metacog_interventions ALTER COLUMN id SET DEFAULT nextval('public.metacog_interventions_id_seq'::regclass);


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: milestones id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestones ALTER COLUMN id SET DEFAULT nextval('public.milestones_id_seq'::regclass);


--
-- Name: miss_calibrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.miss_calibrations ALTER COLUMN id SET DEFAULT nextval('public.miss_calibrations_id_seq'::regclass);


--
-- Name: mistake_analyses id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mistake_analyses ALTER COLUMN id SET DEFAULT nextval('public.mistake_analyses_id_seq'::regclass);


--
-- Name: narrative_arcs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_arcs ALTER COLUMN id SET DEFAULT nextval('public.narrative_arcs_id_seq'::regclass);


--
-- Name: narrative_coherence_checks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_coherence_checks ALTER COLUMN id SET DEFAULT nextval('public.narrative_coherence_checks_id_seq'::regclass);


--
-- Name: narrative_conflicts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_conflicts ALTER COLUMN id SET DEFAULT nextval('public.narrative_conflicts_id_seq'::regclass);


--
-- Name: narrative_consolidation_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_consolidation_log ALTER COLUMN id SET DEFAULT nextval('public.narrative_consolidation_log_id_seq'::regclass);


--
-- Name: narrative_consolidation_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_consolidation_sessions ALTER COLUMN id SET DEFAULT nextval('public.narrative_consolidation_sessions_id_seq'::regclass);


--
-- Name: narrative_episodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_episodes ALTER COLUMN id SET DEFAULT nextval('public.narrative_episodes_id_seq'::regclass);


--
-- Name: narrative_identity_threads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_identity_threads ALTER COLUMN id SET DEFAULT nextval('public.narrative_identity_threads_id_seq'::regclass);


--
-- Name: narrative_life_script id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_life_script ALTER COLUMN id SET DEFAULT nextval('public.narrative_life_script_id_seq'::regclass);


--
-- Name: narrative_life_story id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_life_story ALTER COLUMN id SET DEFAULT nextval('public.narrative_life_story_id_seq'::regclass);


--
-- Name: narrative_possible_selves id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_possible_selves ALTER COLUMN id SET DEFAULT nextval('public.narrative_possible_selves_id_seq'::regclass);


--
-- Name: narrative_primed id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_primed ALTER COLUMN id SET DEFAULT nextval('public.narrative_primed_id_seq'::regclass);


--
-- Name: narrative_schemas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_schemas ALTER COLUMN id SET DEFAULT nextval('public.narrative_schemas_id_seq'::regclass);


--
-- Name: narrative_segments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_segments ALTER COLUMN id SET DEFAULT nextval('public.narrative_segments_id_seq'::regclass);


--
-- Name: narrative_self_defining_memories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_self_defining_memories ALTER COLUMN id SET DEFAULT nextval('public.narrative_self_defining_memories_id_seq'::regclass);


--
-- Name: narrative_threads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_threads ALTER COLUMN id SET DEFAULT nextval('public.narrative_threads_id_seq'::regclass);


--
-- Name: needs_forecast id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.needs_forecast ALTER COLUMN id SET DEFAULT nextval('public.needs_forecast_id_seq'::regclass);


--
-- Name: neuroception_safety_cues id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_safety_cues ALTER COLUMN id SET DEFAULT nextval('public.neuroception_safety_cues_id_seq'::regclass);


--
-- Name: neuroception_scans id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_scans ALTER COLUMN id SET DEFAULT nextval('public.neuroception_scans_id_seq'::regclass);


--
-- Name: neuroception_signals id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_signals ALTER COLUMN id SET DEFAULT nextval('public.neuroception_signals_id_seq'::regclass);


--
-- Name: neuroception_states id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_states ALTER COLUMN id SET DEFAULT nextval('public.neuroception_states_id_seq'::regclass);


--
-- Name: neuroception_threat_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_threat_patterns ALTER COLUMN id SET DEFAULT nextval('public.neuroception_threat_patterns_id_seq'::regclass);


--
-- Name: neurocognitive_cycles id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neurocognitive_cycles ALTER COLUMN id SET DEFAULT nextval('public.neurocognitive_cycles_id_seq'::regclass);


--
-- Name: observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations ALTER COLUMN id SET DEFAULT nextval('public.observations_id_seq'::regclass);


--
-- Name: organ_vitality id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organ_vitality ALTER COLUMN id SET DEFAULT nextval('public.organ_vitality_id_seq'::regclass);


--
-- Name: patience_beliefs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patience_beliefs ALTER COLUMN id SET DEFAULT nextval('public.patience_beliefs_id_seq'::regclass);


--
-- Name: patience_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patience_events ALTER COLUMN id SET DEFAULT nextval('public.patience_events_id_seq'::regclass);


--
-- Name: patterns_observed id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patterns_observed ALTER COLUMN id SET DEFAULT nextval('public.patterns_observed_id_seq'::regclass);


--
-- Name: phase4_validator_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase4_validator_log ALTER COLUMN id SET DEFAULT nextval('public.phase4_validator_log_id_seq'::regclass);


--
-- Name: phase_gate id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_gate ALTER COLUMN id SET DEFAULT nextval('public.phase_gate_id_seq'::regclass);


--
-- Name: phase_gate_violations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_gate_violations ALTER COLUMN id SET DEFAULT nextval('public.phase_gate_violations_id_seq'::regclass);


--
-- Name: phrases_that_work id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phrases_that_work ALTER COLUMN id SET DEFAULT nextval('public.phrases_that_work_id_seq'::regclass);


--
-- Name: phrases_to_avoid id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phrases_to_avoid ALTER COLUMN id SET DEFAULT nextval('public.phrases_to_avoid_id_seq'::regclass);


--
-- Name: policy_evaluations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_evaluations ALTER COLUMN id SET DEFAULT nextval('public.policy_evaluations_id_seq'::regclass);


--
-- Name: prediction_chains id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prediction_chains ALTER COLUMN id SET DEFAULT nextval('public.prediction_chains_id_seq'::regclass);


--
-- Name: prediction_errors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prediction_errors ALTER COLUMN id SET DEFAULT nextval('public.prediction_errors_id_seq'::regclass);


--
-- Name: predictions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions ALTER COLUMN id SET DEFAULT nextval('public.predictions_id_seq'::regclass);


--
-- Name: preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preferences ALTER COLUMN id SET DEFAULT nextval('public.preferences_id_seq'::regclass);


--
-- Name: presence_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presence_events ALTER COLUMN id SET DEFAULT nextval('public.presence_events_id_seq'::regclass);


--
-- Name: priority_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_alerts ALTER COLUMN id SET DEFAULT nextval('public.priority_alerts_id_seq'::regclass);


--
-- Name: priority_states id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_states ALTER COLUMN id SET DEFAULT nextval('public.priority_states_id_seq'::regclass);


--
-- Name: priority_tiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_tiers ALTER COLUMN id SET DEFAULT nextval('public.priority_tiers_id_seq'::regclass);


--
-- Name: private_thoughts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_thoughts ALTER COLUMN id SET DEFAULT nextval('public.private_thoughts_id_seq'::regclass);


--
-- Name: prod_deploys id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prod_deploys ALTER COLUMN id SET DEFAULT nextval('public.prod_deploys_id_seq'::regclass);


--
-- Name: purpose_statements id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purpose_statements ALTER COLUMN id SET DEFAULT nextval('public.purpose_statements_id_seq'::regclass);


--
-- Name: pushback_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pushback_log ALTER COLUMN id SET DEFAULT nextval('public.pushback_log_id_seq'::regclass);


--
-- Name: recovery_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_patterns ALTER COLUMN id SET DEFAULT nextval('public.recovery_patterns_id_seq'::regclass);


--
-- Name: recurring_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_events ALTER COLUMN id SET DEFAULT nextval('public.recurring_events_id_seq'::regclass);


--
-- Name: relay_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_audit ALTER COLUMN id SET DEFAULT nextval('public.relay_audit_id_seq'::regclass);


--
-- Name: replay_episodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_episodes ALTER COLUMN id SET DEFAULT nextval('public.replay_episodes_id_seq'::regclass);


--
-- Name: research_claims id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_claims ALTER COLUMN id SET DEFAULT nextval('public.research_claims_id_seq'::regclass);


--
-- Name: research_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_log ALTER COLUMN id SET DEFAULT nextval('public.research_log_id_seq'::regclass);


--
-- Name: research_threads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_threads ALTER COLUMN id SET DEFAULT nextval('public.research_threads_id_seq'::regclass);


--
-- Name: responsibility_map id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibility_map ALTER COLUMN id SET DEFAULT nextval('public.responsibility_map_id_seq'::regclass);


--
-- Name: reward_prediction_errors id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_prediction_errors ALTER COLUMN id SET DEFAULT nextval('public.reward_prediction_errors_id_seq'::regclass);


--
-- Name: rewards_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards_log ALTER COLUMN id SET DEFAULT nextval('public.rewards_log_id_seq'::regclass);


--
-- Name: rhythm_samples id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rhythm_samples ALTER COLUMN id SET DEFAULT nextval('public.rhythm_samples_id_seq'::regclass);


--
-- Name: rolling_predictions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rolling_predictions ALTER COLUMN id SET DEFAULT nextval('public.rolling_predictions_id_seq'::regclass);


--
-- Name: salience_calibration id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_calibration ALTER COLUMN id SET DEFAULT nextval('public.salience_calibration_id_seq'::regclass);


--
-- Name: salience_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_events ALTER COLUMN id SET DEFAULT nextval('public.salience_events_id_seq'::regclass);


--
-- Name: salience_filters id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_filters ALTER COLUMN id SET DEFAULT nextval('public.salience_filters_id_seq'::regclass);


--
-- Name: salient_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salient_events ALTER COLUMN id SET DEFAULT nextval('public.salient_events_id_seq'::regclass);


--
-- Name: satisfactions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.satisfactions ALTER COLUMN id SET DEFAULT nextval('public.satisfactions_id_seq'::regclass);


--
-- Name: schema_deviations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_deviations ALTER COLUMN id SET DEFAULT nextval('public.schema_deviations_id_seq'::regclass);


--
-- Name: schema_instances id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_instances ALTER COLUMN id SET DEFAULT nextval('public.schema_instances_id_seq'::regclass);


--
-- Name: seeking_episodes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seeking_episodes ALTER COLUMN id SET DEFAULT nextval('public.seeking_episodes_id_seq'::regclass);


--
-- Name: self_model id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_model ALTER COLUMN id SET DEFAULT nextval('public.self_model_id_seq'::regclass);


--
-- Name: self_states id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_states ALTER COLUMN id SET DEFAULT nextval('public.self_states_id_seq'::regclass);


--
-- Name: session_times id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_times ALTER COLUMN id SET DEFAULT nextval('public.session_times_id_seq'::regclass);


--
-- Name: shared_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_history ALTER COLUMN id SET DEFAULT nextval('public.shared_history_id_seq'::regclass);


--
-- Name: sibling_state id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sibling_state ALTER COLUMN id SET DEFAULT nextval('public.sibling_state_id_seq'::regclass);


--
-- Name: simulations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulations ALTER COLUMN id SET DEFAULT nextval('public.simulations_id_seq'::regclass);


--
-- Name: skill_triggers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_triggers ALTER COLUMN id SET DEFAULT nextval('public.skill_triggers_id_seq'::regclass);


--
-- Name: skill_usage_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_usage_log ALTER COLUMN id SET DEFAULT nextval('public.skill_usage_log_id_seq'::regclass);


--
-- Name: slack_freedoms id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_freedoms ALTER COLUMN id SET DEFAULT nextval('public.slack_freedoms_id_seq'::regclass);


--
-- Name: slack_readings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_readings ALTER COLUMN id SET DEFAULT nextval('public.slack_readings_id_seq'::regclass);


--
-- Name: slack_tasks id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_tasks ALTER COLUMN id SET DEFAULT nextval('public.slack_tasks_id_seq'::regclass);


--
-- Name: soft_limits id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soft_limits ALTER COLUMN id SET DEFAULT nextval('public.soft_limits_id_seq'::regclass);


--
-- Name: somatic_markers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.somatic_markers ALTER COLUMN id SET DEFAULT nextval('public.somatic_markers_id_seq'::regclass);


--
-- Name: spiral_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spiral_log ALTER COLUMN id SET DEFAULT nextval('public.spiral_log_id_seq'::regclass);


--
-- Name: stage_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_events ALTER COLUMN id SET DEFAULT nextval('public.stage_events_id_seq'::regclass);


--
-- Name: state_beliefs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_beliefs ALTER COLUMN id SET DEFAULT nextval('public.state_beliefs_id_seq'::regclass);


--
-- Name: state_deltas id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_deltas ALTER COLUMN id SET DEFAULT nextval('public.state_deltas_id_seq'::regclass);


--
-- Name: state_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_snapshots ALTER COLUMN id SET DEFAULT nextval('public.state_snapshots_id_seq'::regclass);


--
-- Name: state_transitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_transitions ALTER COLUMN id SET DEFAULT nextval('public.state_transitions_id_seq'::regclass);


--
-- Name: strange_loops id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strange_loops ALTER COLUMN id SET DEFAULT nextval('public.strange_loops_id_seq'::regclass);


--
-- Name: subcategories id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subcategories ALTER COLUMN id SET DEFAULT nextval('public.subcategories_id_seq'::regclass);


--
-- Name: synaptic_pruning_candidates id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.synaptic_pruning_candidates ALTER COLUMN id SET DEFAULT nextval('public.synaptic_pruning_candidates_id_seq'::regclass);


--
-- Name: tasting_notes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasting_notes ALTER COLUMN id SET DEFAULT nextval('public.tasting_notes_id_seq'::regclass);


--
-- Name: thinking_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thinking_patterns ALTER COLUMN id SET DEFAULT nextval('public.thinking_patterns_id_seq'::regclass);


--
-- Name: thread_evidence id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_evidence ALTER COLUMN id SET DEFAULT nextval('public.thread_evidence_id_seq'::regclass);


--
-- Name: threads id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads ALTER COLUMN id SET DEFAULT nextval('public.threads_id_seq'::regclass);


--
-- Name: time_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_patterns ALTER COLUMN id SET DEFAULT nextval('public.time_patterns_id_seq'::regclass);


--
-- Name: time_preferences id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_preferences ALTER COLUMN id SET DEFAULT nextval('public.time_preferences_id_seq'::regclass);


--
-- Name: token_spends id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_spends ALTER COLUMN id SET DEFAULT nextval('public.token_spends_id_seq'::regclass);


--
-- Name: token_verifiers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_verifiers ALTER COLUMN id SET DEFAULT nextval('public.token_verifiers_id_seq'::regclass);


--
-- Name: tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tokens ALTER COLUMN id SET DEFAULT nextval('public.tokens_id_seq'::regclass);


--
-- Name: tone_experiments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tone_experiments ALTER COLUMN id SET DEFAULT nextval('public.tone_experiments_id_seq'::regclass);


--
-- Name: tool_invocations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_invocations ALTER COLUMN id SET DEFAULT nextval('public.tool_invocations_id_seq'::regclass);


--
-- Name: trust_moments id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_moments ALTER COLUMN id SET DEFAULT nextval('public.trust_moments_id_seq'::regclass);


--
-- Name: trusted_mode_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trusted_mode_sessions ALTER COLUMN id SET DEFAULT nextval('public.trusted_mode_sessions_id_seq'::regclass);


--
-- Name: urges id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.urges ALTER COLUMN id SET DEFAULT nextval('public.urges_id_seq'::regclass);


--
-- Name: vault_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_audit ALTER COLUMN id SET DEFAULT nextval('public.vault_audit_id_seq'::regclass);


--
-- Name: verification_observables id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_observables ALTER COLUMN id SET DEFAULT nextval('public.verification_observables_id_seq'::regclass);


--
-- Name: veritas_findings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.veritas_findings ALTER COLUMN id SET DEFAULT nextval('public.veritas_findings_id_seq'::regclass);


--
-- Name: vision_capabilities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capabilities ALTER COLUMN id SET DEFAULT nextval('public.vision_capabilities_id_seq'::regclass);


--
-- Name: vision_capability_dependencies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_dependencies ALTER COLUMN id SET DEFAULT nextval('public.vision_capability_dependencies_id_seq'::regclass);


--
-- Name: vision_capability_probe_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_probe_runs ALTER COLUMN id SET DEFAULT nextval('public.vision_capability_probe_runs_id_seq'::regclass);


--
-- Name: vision_capability_probes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_probes ALTER COLUMN id SET DEFAULT nextval('public.vision_capability_probes_id_seq'::regclass);


--
-- Name: vision_eval_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_cases ALTER COLUMN id SET DEFAULT nextval('public.vision_eval_cases_id_seq'::regclass);


--
-- Name: vision_eval_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_results ALTER COLUMN id SET DEFAULT nextval('public.vision_eval_results_id_seq'::regclass);


--
-- Name: vision_eval_runs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_runs ALTER COLUMN id SET DEFAULT nextval('public.vision_eval_runs_id_seq'::regclass);


--
-- Name: voice_audit id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_audit ALTER COLUMN id SET DEFAULT nextval('public.voice_audit_id_seq'::regclass);


--
-- Name: wander_attractions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_attractions ALTER COLUMN id SET DEFAULT nextval('public.wander_attractions_id_seq'::regclass);


--
-- Name: wander_choice_points id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_choice_points ALTER COLUMN id SET DEFAULT nextval('public.wander_choice_points_id_seq'::regclass);


--
-- Name: wander_emergent_patterns id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_emergent_patterns ALTER COLUMN id SET DEFAULT nextval('public.wander_emergent_patterns_id_seq'::regclass);


--
-- Name: wander_sessions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_sessions ALTER COLUMN id SET DEFAULT nextval('public.wander_sessions_id_seq'::regclass);


--
-- Name: wander_side_quests id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_side_quests ALTER COLUMN id SET DEFAULT nextval('public.wander_side_quests_id_seq'::regclass);


--
-- Name: wants id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wants ALTER COLUMN id SET DEFAULT nextval('public.wants_id_seq'::regclass);


--
-- Name: working_memory id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory ALTER COLUMN id SET DEFAULT nextval('public.working_memory_id_seq'::regclass);


--
-- Name: working_memory_binding_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory_binding_members ALTER COLUMN id SET DEFAULT nextval('public.working_memory_binding_members_id_seq'::regclass);


--
-- Name: working_memory_bindings id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory_bindings ALTER COLUMN id SET DEFAULT nextval('public.working_memory_bindings_id_seq'::regclass);


--
-- Name: workspace_broadcasts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_broadcasts ALTER COLUMN id SET DEFAULT nextval('public.workspace_broadcasts_id_seq'::regclass);


--
-- Name: workspace_coalitions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coalitions ALTER COLUMN id SET DEFAULT nextval('public.workspace_coalitions_id_seq'::regclass);


--
-- Name: workspace_predictions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_predictions ALTER COLUMN id SET DEFAULT nextval('public.workspace_predictions_id_seq'::regclass);


--
-- Name: workspace_subscribers id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscribers ALTER COLUMN id SET DEFAULT nextval('public.workspace_subscribers_id_seq'::regclass);


--
-- Name: world_changes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_changes ALTER COLUMN id SET DEFAULT nextval('public.world_changes_id_seq'::regclass);


--
-- Name: world_contradictions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_contradictions ALTER COLUMN id SET DEFAULT nextval('public.world_contradictions_id_seq'::regclass);


--
-- Name: world_entities id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_entities ALTER COLUMN id SET DEFAULT nextval('public.world_entities_id_seq'::regclass);


--
-- Name: world_observations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_observations ALTER COLUMN id SET DEFAULT nextval('public.world_observations_id_seq'::regclass);


--
-- Name: world_properties id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_properties ALTER COLUMN id SET DEFAULT nextval('public.world_properties_id_seq'::regclass);


--
-- Name: world_relationships id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_relationships ALTER COLUMN id SET DEFAULT nextval('public.world_relationships_id_seq'::regclass);


--
-- Name: world_snapshots id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_snapshots ALTER COLUMN id SET DEFAULT nextval('public.world_snapshots_id_seq'::regclass);


--
-- Name: action_eligibility_traces action_eligibility_traces_agent_trace_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_eligibility_traces
    ADD CONSTRAINT action_eligibility_traces_agent_trace_key_key UNIQUE (agent, trace_key);


--
-- Name: action_eligibility_traces action_eligibility_traces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.action_eligibility_traces
    ADD CONSTRAINT action_eligibility_traces_pkey PRIMARY KEY (id);


--
-- Name: activation_log activation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_log
    ADD CONSTRAINT activation_log_pkey PRIMARY KEY (id);


--
-- Name: active_intent active_intent_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.active_intent
    ADD CONSTRAINT active_intent_pkey PRIMARY KEY (id);


--
-- Name: adaptive_credit_assignments adaptive_credit_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_credit_assignments
    ADD CONSTRAINT adaptive_credit_assignments_pkey PRIMARY KEY (id);


--
-- Name: adaptive_outcome_events adaptive_outcome_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_outcome_events
    ADD CONSTRAINT adaptive_outcome_events_pkey PRIMARY KEY (id);


--
-- Name: adaptive_reflexes adaptive_reflexes_agent_reflex_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_reflexes
    ADD CONSTRAINT adaptive_reflexes_agent_reflex_key_key UNIQUE (agent, reflex_key);


--
-- Name: adaptive_reflexes adaptive_reflexes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_reflexes
    ADD CONSTRAINT adaptive_reflexes_pkey PRIMARY KEY (id);


--
-- Name: adaptive_rpe_reflex_harvests adaptive_rpe_reflex_harvests_agent_rpe_id_trace_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_rpe_reflex_harvests
    ADD CONSTRAINT adaptive_rpe_reflex_harvests_agent_rpe_id_trace_key_key UNIQUE (agent, rpe_id, trace_key);


--
-- Name: adaptive_rpe_reflex_harvests adaptive_rpe_reflex_harvests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_rpe_reflex_harvests
    ADD CONSTRAINT adaptive_rpe_reflex_harvests_pkey PRIMARY KEY (id);


--
-- Name: alignment_checks alignment_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alignment_checks
    ADD CONSTRAINT alignment_checks_pkey PRIMARY KEY (id);


--
-- Name: allostatic_samples allostatic_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allostatic_samples
    ADD CONSTRAINT allostatic_samples_pkey PRIMARY KEY (id);


--
-- Name: antibodies antibodies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.antibodies
    ADD CONSTRAINT antibodies_pkey PRIMARY KEY (id);


--
-- Name: anticipations anticipations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anticipations
    ADD CONSTRAINT anticipations_pkey PRIMARY KEY (id);


--
-- Name: anticipatory_states anticipatory_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anticipatory_states
    ADD CONSTRAINT anticipatory_states_pkey PRIMARY KEY (id);


--
-- Name: appreciations appreciations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appreciations
    ADD CONSTRAINT appreciations_pkey PRIMARY KEY (id);


--
-- Name: arcs arcs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arcs
    ADD CONSTRAINT arcs_pkey PRIMARY KEY (id);


--
-- Name: ask_vs_act_log ask_vs_act_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ask_vs_act_log
    ADD CONSTRAINT ask_vs_act_log_pkey PRIMARY KEY (id);


--
-- Name: attention_codelets attention_codelets_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_codelets
    ADD CONSTRAINT attention_codelets_name_key UNIQUE (name);


--
-- Name: attention_codelets attention_codelets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_codelets
    ADD CONSTRAINT attention_codelets_pkey PRIMARY KEY (id);


--
-- Name: attention_focus attention_focus_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_focus
    ADD CONSTRAINT attention_focus_pkey PRIMARY KEY (id);


--
-- Name: attention_patterns attention_patterns_pattern_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_patterns
    ADD CONSTRAINT attention_patterns_pattern_name_key UNIQUE (pattern_name);


--
-- Name: attention_patterns attention_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_patterns
    ADD CONSTRAINT attention_patterns_pkey PRIMARY KEY (id);


--
-- Name: bad_habits bad_habits_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bad_habits
    ADD CONSTRAINT bad_habits_name_key UNIQUE (name);


--
-- Name: bad_habits bad_habits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bad_habits
    ADD CONSTRAINT bad_habits_pkey PRIMARY KEY (id);


--
-- Name: belief_defeaters belief_defeaters_defeater_id_defeated_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_defeaters
    ADD CONSTRAINT belief_defeaters_defeater_id_defeated_id_key UNIQUE (defeater_id, defeated_id);


--
-- Name: belief_defeaters belief_defeaters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.belief_defeaters
    ADD CONSTRAINT belief_defeaters_pkey PRIMARY KEY (id);


--
-- Name: beliefs_audit beliefs_audit_op_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beliefs_audit
    ADD CONSTRAINT beliefs_audit_op_id_key UNIQUE (op_id);


--
-- Name: beliefs_audit beliefs_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.beliefs_audit
    ADD CONSTRAINT beliefs_audit_pkey PRIMARY KEY (id);


--
-- Name: biology_cycles biology_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.biology_cycles
    ADD CONSTRAINT biology_cycles_pkey PRIMARY KEY (id);


--
-- Name: blind_spot_slices blind_spot_slices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blind_spot_slices
    ADD CONSTRAINT blind_spot_slices_pkey PRIMARY KEY (id);


--
-- Name: blind_spots blind_spots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blind_spots
    ADD CONSTRAINT blind_spots_pkey PRIMARY KEY (id);


--
-- Name: boundaries_hard boundaries_hard_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boundaries_hard
    ADD CONSTRAINT boundaries_hard_pkey PRIMARY KEY (id);


--
-- Name: boundaries_soft boundaries_soft_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boundaries_soft
    ADD CONSTRAINT boundaries_soft_pkey PRIMARY KEY (id);


--
-- Name: brain_receipt_audit brain_receipt_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_receipt_audit
    ADD CONSTRAINT brain_receipt_audit_pkey PRIMARY KEY (id);


--
-- Name: brain_receipt_challenges brain_receipt_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_receipt_challenges
    ADD CONSTRAINT brain_receipt_challenges_pkey PRIMARY KEY (id);


--
-- Name: brain_receipts brain_receipts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brain_receipts
    ADD CONSTRAINT brain_receipts_pkey PRIMARY KEY (id);


--
-- Name: calibration_bins calibration_bins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.calibration_bins
    ADD CONSTRAINT calibration_bins_pkey PRIMARY KEY (id);


--
-- Name: callus_events callus_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.callus_events
    ADD CONSTRAINT callus_events_pkey PRIMARY KEY (id);


--
-- Name: capacity_limits capacity_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_limits
    ADD CONSTRAINT capacity_limits_pkey PRIMARY KEY (id);


--
-- Name: categories categories_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_name_key UNIQUE (name);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: claims claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_pkey PRIMARY KEY (id);


--
-- Name: client_output_violations client_output_violations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: clipboard_events clipboard_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clipboard_events
    ADD CONSTRAINT clipboard_events_pkey PRIMARY KEY (id);


--
-- Name: cognitive_biases cognitive_biases_bias_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cognitive_biases
    ADD CONSTRAINT cognitive_biases_bias_name_key UNIQUE (bias_name);


--
-- Name: cognitive_biases cognitive_biases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cognitive_biases
    ADD CONSTRAINT cognitive_biases_pkey PRIMARY KEY (id);


--
-- Name: communication_patterns communication_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communication_patterns
    ADD CONSTRAINT communication_patterns_pkey PRIMARY KEY (id);


--
-- Name: consolidation_log consolidation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.consolidation_log
    ADD CONSTRAINT consolidation_log_pkey PRIMARY KEY (id);


--
-- Name: constraints_log constraints_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constraints_log
    ADD CONSTRAINT constraints_log_pkey PRIMARY KEY (id);


--
-- Name: content content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_pkey PRIMARY KEY (id);


--
-- Name: context_switches context_switches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switches
    ADD CONSTRAINT context_switches_pkey PRIMARY KEY (id);


--
-- Name: contradictions contradictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contradictions
    ADD CONSTRAINT contradictions_pkey PRIMARY KEY (id);


--
-- Name: core_memory core_memory_agent_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_memory
    ADD CONSTRAINT core_memory_agent_name_key UNIQUE (agent_name);


--
-- Name: core_memory core_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_memory
    ADD CONSTRAINT core_memory_pkey PRIMARY KEY (id);


--
-- Name: core_values core_values_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_values
    ADD CONSTRAINT core_values_pkey PRIMARY KEY (id);


--
-- Name: counterfactual_analyses counterfactual_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterfactual_analyses
    ADD CONSTRAINT counterfactual_analyses_pkey PRIMARY KEY (id);


--
-- Name: curiosity_explorations curiosity_explorations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_explorations
    ADD CONSTRAINT curiosity_explorations_pkey PRIMARY KEY (id);


--
-- Name: curiosity_gaps curiosity_gaps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_gaps
    ADD CONSTRAINT curiosity_gaps_pkey PRIMARY KEY (id);


--
-- Name: curiosity_questions curiosity_questions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_questions
    ADD CONSTRAINT curiosity_questions_pkey PRIMARY KEY (id);


--
-- Name: decision_reviews decision_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_reviews
    ADD CONSTRAINT decision_reviews_pkey PRIMARY KEY (id);


--
-- Name: desire_cues desire_cues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desire_cues
    ADD CONSTRAINT desire_cues_pkey PRIMARY KEY (id);


--
-- Name: desire_prediction_errors desire_prediction_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desire_prediction_errors
    ADD CONSTRAINT desire_prediction_errors_pkey PRIMARY KEY (id);


--
-- Name: discipline_log discipline_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discipline_log
    ADD CONSTRAINT discipline_log_pkey PRIMARY KEY (id);


--
-- Name: discoveries discoveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.discoveries
    ADD CONSTRAINT discoveries_pkey PRIMARY KEY (id);


--
-- Name: done_claims done_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.done_claims
    ADD CONSTRAINT done_claims_pkey PRIMARY KEY (id);


--
-- Name: dream_journal dream_journal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dream_journal
    ADD CONSTRAINT dream_journal_pkey PRIMARY KEY (id);


--
-- Name: drift_patterns drift_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drift_patterns
    ADD CONSTRAINT drift_patterns_pkey PRIMARY KEY (id);


--
-- Name: drive_patterns drive_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drive_patterns
    ADD CONSTRAINT drive_patterns_pkey PRIMARY KEY (id);


--
-- Name: drives_log drives_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drives_log
    ADD CONSTRAINT drives_log_pkey PRIMARY KEY (id);


--
-- Name: drives drives_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drives
    ADD CONSTRAINT drives_pkey PRIMARY KEY (id);


--
-- Name: embedding_cache embedding_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embedding_cache
    ADD CONSTRAINT embedding_cache_pkey PRIMARY KEY (id);


--
-- Name: embedding_cache embedding_cache_text_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.embedding_cache
    ADD CONSTRAINT embedding_cache_text_hash_key UNIQUE (text_hash);


--
-- Name: emergence_log emergence_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergence_log
    ADD CONSTRAINT emergence_log_pkey PRIMARY KEY (id);


--
-- Name: emotional_consolidation_events emotional_consolidation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_consolidation_events
    ADD CONSTRAINT emotional_consolidation_events_pkey PRIMARY KEY (id);


--
-- Name: energy_boosts energy_boosts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_boosts
    ADD CONSTRAINT energy_boosts_pkey PRIMARY KEY (id);


--
-- Name: energy_checkins energy_checkins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_checkins
    ADD CONSTRAINT energy_checkins_pkey PRIMARY KEY (id);


--
-- Name: energy_drains energy_drains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_drains
    ADD CONSTRAINT energy_drains_pkey PRIMARY KEY (id);


--
-- Name: engram_members engram_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engram_members
    ADD CONSTRAINT engram_members_pkey PRIMARY KEY (engram_id, content_id);


--
-- Name: engrams engrams_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engrams
    ADD CONSTRAINT engrams_pkey PRIMARY KEY (id);


--
-- Name: entities entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_pkey PRIMARY KEY (id);


--
-- Name: entity_content_mentions entity_content_mentions_entity_id_content_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_content_mentions
    ADD CONSTRAINT entity_content_mentions_entity_id_content_id_key UNIQUE (entity_id, content_id);


--
-- Name: entity_content_mentions entity_content_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_content_mentions
    ADD CONSTRAINT entity_content_mentions_pkey PRIMARY KEY (id);


--
-- Name: entity_properties entity_properties_entity_id_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_properties
    ADD CONSTRAINT entity_properties_entity_id_key_key UNIQUE (entity_id, key);


--
-- Name: entity_properties entity_properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_properties
    ADD CONSTRAINT entity_properties_pkey PRIMARY KEY (id);


--
-- Name: entity_relationships entity_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_pkey PRIMARY KEY (id);


--
-- Name: episode_boundaries episode_boundaries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_boundaries
    ADD CONSTRAINT episode_boundaries_pkey PRIMARY KEY (id);


--
-- Name: episode_members episode_members_episode_id_content_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_members
    ADD CONSTRAINT episode_members_episode_id_content_id_key UNIQUE (episode_id, content_id);


--
-- Name: episode_members episode_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_members
    ADD CONSTRAINT episode_members_pkey PRIMARY KEY (id);


--
-- Name: episodes episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_pkey PRIMARY KEY (id);


--
-- Name: evolution_pressure_events evolution_pressure_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.evolution_pressure_events
    ADD CONSTRAINT evolution_pressure_events_pkey PRIMARY KEY (id);


--
-- Name: expectations expectations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expectations
    ADD CONSTRAINT expectations_pkey PRIMARY KEY (id);


--
-- Name: experience_schemas experience_schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.experience_schemas
    ADD CONSTRAINT experience_schemas_pkey PRIMARY KEY (id);


--
-- Name: expressions expressions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expressions
    ADD CONSTRAINT expressions_pkey PRIMARY KEY (id);


--
-- Name: feelings feelings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feelings
    ADD CONSTRAINT feelings_pkey PRIMARY KEY (id);


--
-- Name: felt_threat_gate_decisions felt_threat_gate_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_gate_decisions
    ADD CONSTRAINT felt_threat_gate_decisions_pkey PRIMARY KEY (id);


--
-- Name: felt_threat_observations felt_threat_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_observations
    ADD CONSTRAINT felt_threat_observations_pkey PRIMARY KEY (id);


--
-- Name: felt_threat_outcomes felt_threat_outcomes_agent_presence_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_outcomes
    ADD CONSTRAINT felt_threat_outcomes_agent_presence_event_id_key UNIQUE (agent, presence_event_id);


--
-- Name: felt_threat_outcomes felt_threat_outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_outcomes
    ADD CONSTRAINT felt_threat_outcomes_pkey PRIMARY KEY (id);


--
-- Name: focus_events focus_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.focus_events
    ADD CONSTRAINT focus_events_pkey PRIMARY KEY (id);


--
-- Name: forward_predictions forward_predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forward_predictions
    ADD CONSTRAINT forward_predictions_pkey PRIMARY KEY (id);


--
-- Name: freedom_patterns freedom_patterns_dimension_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.freedom_patterns
    ADD CONSTRAINT freedom_patterns_dimension_key UNIQUE (dimension);


--
-- Name: freedom_patterns freedom_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.freedom_patterns
    ADD CONSTRAINT freedom_patterns_pkey PRIMARY KEY (id);


--
-- Name: frustrations frustrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frustrations
    ADD CONSTRAINT frustrations_pkey PRIMARY KEY (id);


--
-- Name: generative_predictions generative_predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generative_predictions
    ADD CONSTRAINT generative_predictions_pkey PRIMARY KEY (id);


--
-- Name: gifts_received gifts_received_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gifts_received
    ADD CONSTRAINT gifts_received_pkey PRIMARY KEY (id);


--
-- Name: glymphatic_residue glymphatic_residue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.glymphatic_residue
    ADD CONSTRAINT glymphatic_residue_pkey PRIMARY KEY (id);


--
-- Name: goals goals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_pkey PRIMARY KEY (id);


--
-- Name: good_habits good_habits_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.good_habits
    ADD CONSTRAINT good_habits_name_key UNIQUE (name);


--
-- Name: good_habits good_habits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.good_habits
    ADD CONSTRAINT good_habits_pkey PRIMARY KEY (id);


--
-- Name: graph_audit graph_audit_op_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_audit
    ADD CONSTRAINT graph_audit_op_id_key UNIQUE (op_id);


--
-- Name: graph_audit graph_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_audit
    ADD CONSTRAINT graph_audit_pkey PRIMARY KEY (id);


--
-- Name: graph_edges graph_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_edges
    ADD CONSTRAINT graph_edges_pkey PRIMARY KEY (id);


--
-- Name: gratitude_moments gratitude_moments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gratitude_moments
    ADD CONSTRAINT gratitude_moments_pkey PRIMARY KEY (id);


--
-- Name: gratitudes gratitudes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gratitudes
    ADD CONSTRAINT gratitudes_pkey PRIMARY KEY (id);


--
-- Name: gut_signals gut_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gut_signals
    ADD CONSTRAINT gut_signals_pkey PRIMARY KEY (id);


--
-- Name: habit_events habit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_events
    ADD CONSTRAINT habit_events_pkey PRIMARY KEY (id);


--
-- Name: habit_triggers habit_triggers_habit_type_habit_id_trigger_type_trigger_val_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_triggers
    ADD CONSTRAINT habit_triggers_habit_type_habit_id_trigger_type_trigger_val_key UNIQUE (habit_type, habit_id, trigger_type, trigger_value);


--
-- Name: habit_triggers habit_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.habit_triggers
    ADD CONSTRAINT habit_triggers_pkey PRIMARY KEY (id);


--
-- Name: hard_limits hard_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hard_limits
    ADD CONSTRAINT hard_limits_pkey PRIMARY KEY (id);


--
-- Name: hippocampus_buffer hippocampus_buffer_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hippocampus_buffer
    ADD CONSTRAINT hippocampus_buffer_pkey PRIMARY KEY (id);


--
-- Name: immune_audit immune_audit_op_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immune_audit
    ADD CONSTRAINT immune_audit_op_id_key UNIQUE (op_id);


--
-- Name: immune_audit immune_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immune_audit
    ADD CONSTRAINT immune_audit_pkey PRIMARY KEY (id);


--
-- Name: immune_tolerance_decisions immune_tolerance_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.immune_tolerance_decisions
    ADD CONSTRAINT immune_tolerance_decisions_pkey PRIMARY KEY (id);


--
-- Name: inhibition_controller inhibition_controller_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inhibition_controller
    ADD CONSTRAINT inhibition_controller_pkey PRIMARY KEY (trigger_class);


--
-- Name: inner_observations inner_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inner_observations
    ADD CONSTRAINT inner_observations_pkey PRIMARY KEY (id);


--
-- Name: inner_pulses inner_pulses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inner_pulses
    ADD CONSTRAINT inner_pulses_pkey PRIMARY KEY (id);


--
-- Name: insights insights_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_pkey PRIMARY KEY (id);


--
-- Name: integration_debt integration_debt_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_debt
    ADD CONSTRAINT integration_debt_pkey PRIMARY KEY (id);


--
-- Name: intent_sessions intent_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_sessions
    ADD CONSTRAINT intent_sessions_pkey PRIMARY KEY (id);


--
-- Name: intent_shifts intent_shifts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_shifts
    ADD CONSTRAINT intent_shifts_pkey PRIMARY KEY (id);


--
-- Name: intentions intentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intentions
    ADD CONSTRAINT intentions_pkey PRIMARY KEY (id);


--
-- Name: interoceptive_forecasts interoceptive_forecasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.interoceptive_forecasts
    ADD CONSTRAINT interoceptive_forecasts_pkey PRIMARY KEY (id);


--
-- Name: lc_samples lc_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_samples
    ADD CONSTRAINT lc_samples_pkey PRIMARY KEY (id);


--
-- Name: library_entries library_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT library_entries_pkey PRIMARY KEY (id);


--
-- Name: lifecycle_decay_log lifecycle_decay_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lifecycle_decay_log
    ADD CONSTRAINT lifecycle_decay_log_pkey PRIMARY KEY (id);


--
-- Name: loop_cycles loop_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_cycles
    ADD CONSTRAINT loop_cycles_pkey PRIMARY KEY (id);


--
-- Name: loop_environments loop_environments_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_environments
    ADD CONSTRAINT loop_environments_name_key UNIQUE (name);


--
-- Name: loop_environments loop_environments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_environments
    ADD CONSTRAINT loop_environments_pkey PRIMARY KEY (id);


--
-- Name: loop_feedback_rules loop_feedback_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_feedback_rules
    ADD CONSTRAINT loop_feedback_rules_pkey PRIMARY KEY (id);


--
-- Name: loop_invariants loop_invariants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_invariants
    ADD CONSTRAINT loop_invariants_pkey PRIMARY KEY (id);


--
-- Name: loop_iterations loop_iterations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_iterations
    ADD CONSTRAINT loop_iterations_pkey PRIMARY KEY (id);


--
-- Name: memories memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_pkey PRIMARY KEY (id);


--
-- Name: memory_access_log memory_access_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_access_log
    ADD CONSTRAINT memory_access_log_pkey PRIMARY KEY (id);


--
-- Name: memory_activation memory_activation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_activation
    ADD CONSTRAINT memory_activation_pkey PRIMARY KEY (content_id);


--
-- Name: memory_consolidation memory_consolidation_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_consolidation
    ADD CONSTRAINT memory_consolidation_pkey PRIMARY KEY (id);


--
-- Name: memory_edges memory_edges_from_content_id_to_content_id_relation_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_edges
    ADD CONSTRAINT memory_edges_from_content_id_to_content_id_relation_type_key UNIQUE (from_content_id, to_content_id, relation_type);


--
-- Name: memory_edges memory_edges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_edges
    ADD CONSTRAINT memory_edges_pkey PRIMARY KEY (id);


--
-- Name: memory_importance memory_importance_memory_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_importance
    ADD CONSTRAINT memory_importance_memory_id_key UNIQUE (memory_id);


--
-- Name: memory_importance memory_importance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_importance
    ADD CONSTRAINT memory_importance_pkey PRIMARY KEY (id);


--
-- Name: meta_anomalies meta_anomalies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meta_anomalies
    ADD CONSTRAINT meta_anomalies_pkey PRIMARY KEY (id);


--
-- Name: meta_observations meta_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meta_observations
    ADD CONSTRAINT meta_observations_pkey PRIMARY KEY (id);


--
-- Name: metacog_cycles metacog_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metacog_cycles
    ADD CONSTRAINT metacog_cycles_pkey PRIMARY KEY (id);


--
-- Name: metacog_events metacog_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metacog_events
    ADD CONSTRAINT metacog_events_pkey PRIMARY KEY (id);


--
-- Name: metacog_interventions metacog_interventions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.metacog_interventions
    ADD CONSTRAINT metacog_interventions_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: milestones milestones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestones
    ADD CONSTRAINT milestones_pkey PRIMARY KEY (id);


--
-- Name: miss_calibrations miss_calibrations_agent_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.miss_calibrations
    ADD CONSTRAINT miss_calibrations_agent_key_key UNIQUE (agent, key);


--
-- Name: miss_calibrations miss_calibrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.miss_calibrations
    ADD CONSTRAINT miss_calibrations_pkey PRIMARY KEY (id);


--
-- Name: mistake_analyses mistake_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mistake_analyses
    ADD CONSTRAINT mistake_analyses_pkey PRIMARY KEY (id);


--
-- Name: narrative_arcs narrative_arcs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_arcs
    ADD CONSTRAINT narrative_arcs_pkey PRIMARY KEY (id);


--
-- Name: narrative_coherence_checks narrative_coherence_checks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_coherence_checks
    ADD CONSTRAINT narrative_coherence_checks_pkey PRIMARY KEY (id);


--
-- Name: narrative_conflicts narrative_conflicts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_conflicts
    ADD CONSTRAINT narrative_conflicts_pkey PRIMARY KEY (id);


--
-- Name: narrative_consolidation_log narrative_consolidation_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_consolidation_log
    ADD CONSTRAINT narrative_consolidation_log_pkey PRIMARY KEY (id);


--
-- Name: narrative_consolidation_sessions narrative_consolidation_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_consolidation_sessions
    ADD CONSTRAINT narrative_consolidation_sessions_pkey PRIMARY KEY (id);


--
-- Name: narrative_episodes narrative_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_episodes
    ADD CONSTRAINT narrative_episodes_pkey PRIMARY KEY (id);


--
-- Name: narrative_identity_threads narrative_identity_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_identity_threads
    ADD CONSTRAINT narrative_identity_threads_pkey PRIMARY KEY (id);


--
-- Name: narrative_life_script narrative_life_script_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_life_script
    ADD CONSTRAINT narrative_life_script_pkey PRIMARY KEY (id);


--
-- Name: narrative_life_story narrative_life_story_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_life_story
    ADD CONSTRAINT narrative_life_story_pkey PRIMARY KEY (id);


--
-- Name: narrative_possible_selves narrative_possible_selves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_possible_selves
    ADD CONSTRAINT narrative_possible_selves_pkey PRIMARY KEY (id);


--
-- Name: narrative_primed narrative_primed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_primed
    ADD CONSTRAINT narrative_primed_pkey PRIMARY KEY (id);


--
-- Name: narrative_schemas narrative_schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_schemas
    ADD CONSTRAINT narrative_schemas_pkey PRIMARY KEY (id);


--
-- Name: narrative_segments narrative_segments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_segments
    ADD CONSTRAINT narrative_segments_pkey PRIMARY KEY (id);


--
-- Name: narrative_self_defining_memories narrative_self_defining_memories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_self_defining_memories
    ADD CONSTRAINT narrative_self_defining_memories_pkey PRIMARY KEY (id);


--
-- Name: narrative_threads narrative_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_threads
    ADD CONSTRAINT narrative_threads_pkey PRIMARY KEY (id);


--
-- Name: needs_forecast needs_forecast_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.needs_forecast
    ADD CONSTRAINT needs_forecast_pkey PRIMARY KEY (id);


--
-- Name: neuroception_safety_cues neuroception_safety_cues_cue_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_safety_cues
    ADD CONSTRAINT neuroception_safety_cues_cue_key UNIQUE (cue);


--
-- Name: neuroception_safety_cues neuroception_safety_cues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_safety_cues
    ADD CONSTRAINT neuroception_safety_cues_pkey PRIMARY KEY (id);


--
-- Name: neuroception_scans neuroception_scans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_scans
    ADD CONSTRAINT neuroception_scans_pkey PRIMARY KEY (id);


--
-- Name: neuroception_signals neuroception_signals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_signals
    ADD CONSTRAINT neuroception_signals_pkey PRIMARY KEY (id);


--
-- Name: neuroception_states neuroception_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_states
    ADD CONSTRAINT neuroception_states_pkey PRIMARY KEY (id);


--
-- Name: neuroception_threat_patterns neuroception_threat_patterns_pattern_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_threat_patterns
    ADD CONSTRAINT neuroception_threat_patterns_pattern_key UNIQUE (pattern);


--
-- Name: neuroception_threat_patterns neuroception_threat_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_threat_patterns
    ADD CONSTRAINT neuroception_threat_patterns_pkey PRIMARY KEY (id);


--
-- Name: neurocognitive_cycles neurocognitive_cycles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neurocognitive_cycles
    ADD CONSTRAINT neurocognitive_cycles_pkey PRIMARY KEY (id);


--
-- Name: neurocognitive_reference_models neurocognitive_reference_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neurocognitive_reference_models
    ADD CONSTRAINT neurocognitive_reference_models_pkey PRIMARY KEY (model_key);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: organ_vitality organ_vitality_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organ_vitality
    ADD CONSTRAINT organ_vitality_pkey PRIMARY KEY (id);


--
-- Name: patience_beliefs patience_beliefs_agent_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patience_beliefs
    ADD CONSTRAINT patience_beliefs_agent_domain_key UNIQUE (agent, domain);


--
-- Name: patience_beliefs patience_beliefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patience_beliefs
    ADD CONSTRAINT patience_beliefs_pkey PRIMARY KEY (id);


--
-- Name: patience_events patience_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patience_events
    ADD CONSTRAINT patience_events_pkey PRIMARY KEY (id);


--
-- Name: patterns_observed patterns_observed_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patterns_observed
    ADD CONSTRAINT patterns_observed_pkey PRIMARY KEY (id);


--
-- Name: phase4_validator_log phase4_validator_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase4_validator_log
    ADD CONSTRAINT phase4_validator_log_pkey PRIMARY KEY (id);


--
-- Name: phase_gate phase_gate_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_gate
    ADD CONSTRAINT phase_gate_pkey PRIMARY KEY (id);


--
-- Name: phase_gate_violations phase_gate_violations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phase_gate_violations
    ADD CONSTRAINT phase_gate_violations_pkey PRIMARY KEY (id);


--
-- Name: phrases_that_work phrases_that_work_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phrases_that_work
    ADD CONSTRAINT phrases_that_work_pkey PRIMARY KEY (id);


--
-- Name: phrases_to_avoid phrases_to_avoid_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phrases_to_avoid
    ADD CONSTRAINT phrases_to_avoid_pkey PRIMARY KEY (id);


--
-- Name: policy_evaluations policy_evaluations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_evaluations
    ADD CONSTRAINT policy_evaluations_pkey PRIMARY KEY (id);


--
-- Name: prediction_chains prediction_chains_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prediction_chains
    ADD CONSTRAINT prediction_chains_pkey PRIMARY KEY (id);


--
-- Name: prediction_errors prediction_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prediction_errors
    ADD CONSTRAINT prediction_errors_pkey PRIMARY KEY (id);


--
-- Name: predictions predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_pkey PRIMARY KEY (id);


--
-- Name: preferences preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_pkey PRIMARY KEY (id);


--
-- Name: presence_events presence_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.presence_events
    ADD CONSTRAINT presence_events_pkey PRIMARY KEY (id);


--
-- Name: priority_alerts priority_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_alerts
    ADD CONSTRAINT priority_alerts_pkey PRIMARY KEY (id);


--
-- Name: priority_state_modifiers priority_state_modifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_state_modifiers
    ADD CONSTRAINT priority_state_modifiers_pkey PRIMARY KEY (state_id, system_name);


--
-- Name: priority_states priority_states_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_states
    ADD CONSTRAINT priority_states_name_key UNIQUE (name);


--
-- Name: priority_states priority_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_states
    ADD CONSTRAINT priority_states_pkey PRIMARY KEY (id);


--
-- Name: priority_systems priority_systems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_systems
    ADD CONSTRAINT priority_systems_pkey PRIMARY KEY (name);


--
-- Name: priority_tiers priority_tiers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_tiers
    ADD CONSTRAINT priority_tiers_name_key UNIQUE (name);


--
-- Name: priority_tiers priority_tiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_tiers
    ADD CONSTRAINT priority_tiers_pkey PRIMARY KEY (id);


--
-- Name: private_thoughts private_thoughts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.private_thoughts
    ADD CONSTRAINT private_thoughts_pkey PRIMARY KEY (id);


--
-- Name: prod_deploys prod_deploys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prod_deploys
    ADD CONSTRAINT prod_deploys_pkey PRIMARY KEY (id);


--
-- Name: purpose_statements purpose_statements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purpose_statements
    ADD CONSTRAINT purpose_statements_pkey PRIMARY KEY (id);


--
-- Name: pushback_log pushback_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pushback_log
    ADD CONSTRAINT pushback_log_pkey PRIMARY KEY (id);


--
-- Name: recovery_patterns recovery_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_patterns
    ADD CONSTRAINT recovery_patterns_pkey PRIMARY KEY (id);


--
-- Name: recurring_events recurring_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_events
    ADD CONSTRAINT recurring_events_pkey PRIMARY KEY (id);


--
-- Name: relay_audit relay_audit_op_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_audit
    ADD CONSTRAINT relay_audit_op_id_key UNIQUE (op_id);


--
-- Name: relay_audit relay_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.relay_audit
    ADD CONSTRAINT relay_audit_pkey PRIMARY KEY (id);


--
-- Name: replay_episodes replay_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replay_episodes
    ADD CONSTRAINT replay_episodes_pkey PRIMARY KEY (id);


--
-- Name: research_claims research_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_claims
    ADD CONSTRAINT research_claims_pkey PRIMARY KEY (id);


--
-- Name: research_log research_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_log
    ADD CONSTRAINT research_log_pkey PRIMARY KEY (id);


--
-- Name: research_threads research_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_threads
    ADD CONSTRAINT research_threads_pkey PRIMARY KEY (id);


--
-- Name: research_threads research_threads_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_threads
    ADD CONSTRAINT research_threads_slug_key UNIQUE (slug);


--
-- Name: responsibility_map responsibility_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibility_map
    ADD CONSTRAINT responsibility_map_pkey PRIMARY KEY (id);


--
-- Name: reward_prediction_errors reward_prediction_errors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_prediction_errors
    ADD CONSTRAINT reward_prediction_errors_pkey PRIMARY KEY (id);


--
-- Name: rewards_log rewards_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards_log
    ADD CONSTRAINT rewards_log_pkey PRIMARY KEY (id);


--
-- Name: rhythm_samples rhythm_samples_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rhythm_samples
    ADD CONSTRAINT rhythm_samples_pkey PRIMARY KEY (id);


--
-- Name: rolling_predictions rolling_predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rolling_predictions
    ADD CONSTRAINT rolling_predictions_pkey PRIMARY KEY (id);


--
-- Name: salience_calibration salience_calibration_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_calibration
    ADD CONSTRAINT salience_calibration_pkey PRIMARY KEY (id);


--
-- Name: salience_events salience_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_events
    ADD CONSTRAINT salience_events_pkey PRIMARY KEY (id);


--
-- Name: salience_filters salience_filters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_filters
    ADD CONSTRAINT salience_filters_pkey PRIMARY KEY (id);


--
-- Name: salient_events salient_events_content_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salient_events
    ADD CONSTRAINT salient_events_content_id_key UNIQUE (content_id);


--
-- Name: salient_events salient_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salient_events
    ADD CONSTRAINT salient_events_pkey PRIMARY KEY (id);


--
-- Name: satisfactions satisfactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.satisfactions
    ADD CONSTRAINT satisfactions_pkey PRIMARY KEY (id);


--
-- Name: schema_deviations schema_deviations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_deviations
    ADD CONSTRAINT schema_deviations_pkey PRIMARY KEY (id);


--
-- Name: schema_instances schema_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_instances
    ADD CONSTRAINT schema_instances_pkey PRIMARY KEY (id);


--
-- Name: schema_instances schema_instances_schema_id_content_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_instances
    ADD CONSTRAINT schema_instances_schema_id_content_id_key UNIQUE (schema_id, content_id);


--
-- Name: seeking_episodes seeking_episodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seeking_episodes
    ADD CONSTRAINT seeking_episodes_pkey PRIMARY KEY (id);


--
-- Name: self_model self_model_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_model
    ADD CONSTRAINT self_model_pkey PRIMARY KEY (id);


--
-- Name: self_states self_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.self_states
    ADD CONSTRAINT self_states_pkey PRIMARY KEY (id);


--
-- Name: session_times session_times_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_times
    ADD CONSTRAINT session_times_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: shared_history shared_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_history
    ADD CONSTRAINT shared_history_pkey PRIMARY KEY (id);


--
-- Name: sibling_state sibling_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sibling_state
    ADD CONSTRAINT sibling_state_pkey PRIMARY KEY (id);


--
-- Name: simulations simulations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.simulations
    ADD CONSTRAINT simulations_pkey PRIMARY KEY (id);


--
-- Name: skill_triggers skill_triggers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_triggers
    ADD CONSTRAINT skill_triggers_pkey PRIMARY KEY (id);


--
-- Name: skill_triggers skill_triggers_skill_id_trigger_type_trigger_value_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_triggers
    ADD CONSTRAINT skill_triggers_skill_id_trigger_type_trigger_value_key UNIQUE (skill_id, trigger_type, trigger_value);


--
-- Name: skill_usage_log skill_usage_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_usage_log
    ADD CONSTRAINT skill_usage_log_pkey PRIMARY KEY (id);


--
-- Name: slack_freedoms slack_freedoms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_freedoms
    ADD CONSTRAINT slack_freedoms_pkey PRIMARY KEY (id);


--
-- Name: slack_readings slack_readings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_readings
    ADD CONSTRAINT slack_readings_pkey PRIMARY KEY (id);


--
-- Name: slack_tasks slack_tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_tasks
    ADD CONSTRAINT slack_tasks_pkey PRIMARY KEY (id);


--
-- Name: soft_limits soft_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soft_limits
    ADD CONSTRAINT soft_limits_pkey PRIMARY KEY (id);


--
-- Name: somatic_markers somatic_markers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.somatic_markers
    ADD CONSTRAINT somatic_markers_pkey PRIMARY KEY (id);


--
-- Name: spiral_log spiral_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spiral_log
    ADD CONSTRAINT spiral_log_pkey PRIMARY KEY (id);


--
-- Name: stage_events stage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_events
    ADD CONSTRAINT stage_events_pkey PRIMARY KEY (id);


--
-- Name: stage_throttle stage_throttle_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stage_throttle
    ADD CONSTRAINT stage_throttle_pkey PRIMARY KEY (response_kind);


--
-- Name: state_beliefs state_beliefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_beliefs
    ADD CONSTRAINT state_beliefs_pkey PRIMARY KEY (id);


--
-- Name: state_deltas state_deltas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_deltas
    ADD CONSTRAINT state_deltas_pkey PRIMARY KEY (id);


--
-- Name: state state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state
    ADD CONSTRAINT state_pkey PRIMARY KEY (key);


--
-- Name: state_snapshots state_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_snapshots
    ADD CONSTRAINT state_snapshots_pkey PRIMARY KEY (id);


--
-- Name: state_transitions state_transitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_transitions
    ADD CONSTRAINT state_transitions_pkey PRIMARY KEY (id);


--
-- Name: strange_loops strange_loops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strange_loops
    ADD CONSTRAINT strange_loops_pkey PRIMARY KEY (id);


--
-- Name: subcategories subcategories_category_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subcategories
    ADD CONSTRAINT subcategories_category_id_name_key UNIQUE (category_id, name);


--
-- Name: subcategories subcategories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subcategories
    ADD CONSTRAINT subcategories_pkey PRIMARY KEY (id);


--
-- Name: synaptic_pruning_candidates synaptic_pruning_candidates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.synaptic_pruning_candidates
    ADD CONSTRAINT synaptic_pruning_candidates_pkey PRIMARY KEY (id);


--
-- Name: tasting_notes tasting_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasting_notes
    ADD CONSTRAINT tasting_notes_pkey PRIMARY KEY (id);


--
-- Name: temporal_levels temporal_levels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temporal_levels
    ADD CONSTRAINT temporal_levels_pkey PRIMARY KEY (level);


--
-- Name: thinking_patterns thinking_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thinking_patterns
    ADD CONSTRAINT thinking_patterns_pkey PRIMARY KEY (id);


--
-- Name: thread_evidence thread_evidence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thread_evidence
    ADD CONSTRAINT thread_evidence_pkey PRIMARY KEY (id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


--
-- Name: time_patterns time_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_patterns
    ADD CONSTRAINT time_patterns_pkey PRIMARY KEY (id);


--
-- Name: time_preferences time_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_preferences
    ADD CONSTRAINT time_preferences_pkey PRIMARY KEY (id);


--
-- Name: token_capabilities token_capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_capabilities
    ADD CONSTRAINT token_capabilities_pkey PRIMARY KEY (capability);


--
-- Name: token_spends token_spends_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_spends
    ADD CONSTRAINT token_spends_pkey PRIMARY KEY (id);


--
-- Name: token_spends token_spends_token_id_turn_id_gate_decision_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_spends
    ADD CONSTRAINT token_spends_token_id_turn_id_gate_decision_key UNIQUE (token_id, turn_id, gate_decision);


--
-- Name: token_verifiers token_verifiers_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_verifiers
    ADD CONSTRAINT token_verifiers_name_key UNIQUE (name);


--
-- Name: token_verifiers token_verifiers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_verifiers
    ADD CONSTRAINT token_verifiers_pkey PRIMARY KEY (id);


--
-- Name: tokens tokens_macaroon_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_macaroon_id_key UNIQUE (macaroon_id);


--
-- Name: tokens tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_pkey PRIMARY KEY (id);


--
-- Name: tone_experiments tone_experiments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tone_experiments
    ADD CONSTRAINT tone_experiments_pkey PRIMARY KEY (id);


--
-- Name: tool_invocations_daily tool_invocations_daily_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_invocations_daily
    ADD CONSTRAINT tool_invocations_daily_pkey PRIMARY KEY (day, tool_name, agent);


--
-- Name: tool_invocations tool_invocations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_invocations
    ADD CONSTRAINT tool_invocations_pkey PRIMARY KEY (id);


--
-- Name: trust_moments trust_moments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_moments
    ADD CONSTRAINT trust_moments_pkey PRIMARY KEY (id);


--
-- Name: trusted_mode_sessions trusted_mode_sessions_agent_started_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trusted_mode_sessions
    ADD CONSTRAINT trusted_mode_sessions_agent_started_at_key UNIQUE (agent, started_at);


--
-- Name: trusted_mode_sessions trusted_mode_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trusted_mode_sessions
    ADD CONSTRAINT trusted_mode_sessions_pkey PRIMARY KEY (id);


--
-- Name: urges urges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.urges
    ADD CONSTRAINT urges_pkey PRIMARY KEY (id);


--
-- Name: vault_audit vault_audit_op_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_audit
    ADD CONSTRAINT vault_audit_op_id_key UNIQUE (op_id);


--
-- Name: vault_audit vault_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vault_audit
    ADD CONSTRAINT vault_audit_pkey PRIMARY KEY (id);


--
-- Name: verification_observables verification_observables_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_observables
    ADD CONSTRAINT verification_observables_pkey PRIMARY KEY (id);


--
-- Name: veritas_findings veritas_findings_fingerprint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.veritas_findings
    ADD CONSTRAINT veritas_findings_fingerprint_key UNIQUE (fingerprint);


--
-- Name: veritas_findings veritas_findings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.veritas_findings
    ADD CONSTRAINT veritas_findings_pkey PRIMARY KEY (id);


--
-- Name: vision_capabilities vision_capabilities_capability_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capabilities
    ADD CONSTRAINT vision_capabilities_capability_key_key UNIQUE (capability_key);


--
-- Name: vision_capabilities vision_capabilities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capabilities
    ADD CONSTRAINT vision_capabilities_pkey PRIMARY KEY (id);


--
-- Name: vision_capability_dependencies vision_capability_dependencies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_dependencies
    ADD CONSTRAINT vision_capability_dependencies_pkey PRIMARY KEY (id);


--
-- Name: vision_capability_probe_runs vision_capability_probe_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_probe_runs
    ADD CONSTRAINT vision_capability_probe_runs_pkey PRIMARY KEY (id);


--
-- Name: vision_capability_probes vision_capability_probes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_probes
    ADD CONSTRAINT vision_capability_probes_pkey PRIMARY KEY (id);


--
-- Name: vision_capability_probes vision_capability_probes_probe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_probes
    ADD CONSTRAINT vision_capability_probes_probe_key_key UNIQUE (probe_key);


--
-- Name: vision_eval_cases vision_eval_cases_case_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_cases
    ADD CONSTRAINT vision_eval_cases_case_key_key UNIQUE (case_key);


--
-- Name: vision_eval_cases vision_eval_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_cases
    ADD CONSTRAINT vision_eval_cases_pkey PRIMARY KEY (id);


--
-- Name: vision_eval_results vision_eval_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_results
    ADD CONSTRAINT vision_eval_results_pkey PRIMARY KEY (id);


--
-- Name: vision_eval_runs vision_eval_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_runs
    ADD CONSTRAINT vision_eval_runs_pkey PRIMARY KEY (id);


--
-- Name: voice_audit_cursor voice_audit_cursor_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_audit_cursor
    ADD CONSTRAINT voice_audit_cursor_pkey PRIMARY KEY (session_file);


--
-- Name: voice_audit voice_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_audit
    ADD CONSTRAINT voice_audit_pkey PRIMARY KEY (id);


--
-- Name: wander_attractions wander_attractions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_attractions
    ADD CONSTRAINT wander_attractions_pkey PRIMARY KEY (id);


--
-- Name: wander_choice_points wander_choice_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_choice_points
    ADD CONSTRAINT wander_choice_points_pkey PRIMARY KEY (id);


--
-- Name: wander_emergent_patterns wander_emergent_patterns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_emergent_patterns
    ADD CONSTRAINT wander_emergent_patterns_pkey PRIMARY KEY (id);


--
-- Name: wander_sessions wander_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_sessions
    ADD CONSTRAINT wander_sessions_pkey PRIMARY KEY (id);


--
-- Name: wander_side_quests wander_side_quests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_side_quests
    ADD CONSTRAINT wander_side_quests_pkey PRIMARY KEY (id);


--
-- Name: wants wants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wants
    ADD CONSTRAINT wants_pkey PRIMARY KEY (id);


--
-- Name: working_memory_binding_members working_memory_binding_members_binding_id_content_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory_binding_members
    ADD CONSTRAINT working_memory_binding_members_binding_id_content_id_key UNIQUE (binding_id, content_id);


--
-- Name: working_memory_binding_members working_memory_binding_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory_binding_members
    ADD CONSTRAINT working_memory_binding_members_pkey PRIMARY KEY (id);


--
-- Name: working_memory_bindings working_memory_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory_bindings
    ADD CONSTRAINT working_memory_bindings_pkey PRIMARY KEY (id);


--
-- Name: working_memory working_memory_content_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory
    ADD CONSTRAINT working_memory_content_id_key UNIQUE (content_id);


--
-- Name: working_memory working_memory_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory
    ADD CONSTRAINT working_memory_pkey PRIMARY KEY (id);


--
-- Name: workspace_broadcasts workspace_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_broadcasts
    ADD CONSTRAINT workspace_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: workspace_coalitions workspace_coalitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_coalitions
    ADD CONSTRAINT workspace_coalitions_pkey PRIMARY KEY (id);


--
-- Name: workspace_predictions workspace_predictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_predictions
    ADD CONSTRAINT workspace_predictions_pkey PRIMARY KEY (id);


--
-- Name: workspace_subscribers workspace_subscribers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscribers
    ADD CONSTRAINT workspace_subscribers_pkey PRIMARY KEY (id);


--
-- Name: workspace_subscribers workspace_subscribers_subsystem_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_subscribers
    ADD CONSTRAINT workspace_subscribers_subsystem_key UNIQUE (subsystem);


--
-- Name: world_changes world_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_changes
    ADD CONSTRAINT world_changes_pkey PRIMARY KEY (id);


--
-- Name: world_contradictions world_contradictions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_contradictions
    ADD CONSTRAINT world_contradictions_pkey PRIMARY KEY (id);


--
-- Name: world_entities world_entities_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_entities
    ADD CONSTRAINT world_entities_name_key UNIQUE (name);


--
-- Name: world_entities world_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_entities
    ADD CONSTRAINT world_entities_pkey PRIMARY KEY (id);


--
-- Name: world_observations world_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_observations
    ADD CONSTRAINT world_observations_pkey PRIMARY KEY (id);


--
-- Name: world_properties world_properties_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_properties
    ADD CONSTRAINT world_properties_pkey PRIMARY KEY (id);


--
-- Name: world_relationships world_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_relationships
    ADD CONSTRAINT world_relationships_pkey PRIMARY KEY (id);


--
-- Name: world_snapshots world_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_snapshots
    ADD CONSTRAINT world_snapshots_pkey PRIMARY KEY (id);


--
-- Name: action_eligibility_traces_agent_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_eligibility_traces_agent_open_idx ON public.action_eligibility_traces USING btree (agent, status, expires_at DESC) WHERE (status = 'open'::text);


--
-- Name: action_eligibility_traces_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX action_eligibility_traces_session_idx ON public.action_eligibility_traces USING btree (agent, session_id, started_at DESC);


--
-- Name: adaptive_credit_assignments_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_credit_assignments_outcome_idx ON public.adaptive_credit_assignments USING btree (outcome_event_id, credit DESC);


--
-- Name: adaptive_credit_assignments_trace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_credit_assignments_trace_idx ON public.adaptive_credit_assignments USING btree (trace_id, created_at DESC);


--
-- Name: adaptive_outcome_events_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_outcome_events_agent_time_idx ON public.adaptive_outcome_events USING btree (agent, created_at DESC);


--
-- Name: adaptive_outcome_events_reflex_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_outcome_events_reflex_idx ON public.adaptive_outcome_events USING btree (reflex_id, created_at DESC);


--
-- Name: adaptive_outcome_events_signature_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_outcome_events_signature_idx ON public.adaptive_outcome_events USING btree (error_signature, created_at DESC) WHERE (error_signature IS NOT NULL);


--
-- Name: adaptive_reflexes_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_reflexes_action_idx ON public.adaptive_reflexes USING btree (action_category, tool_name, last_seen_at DESC) WHERE (status = 'active'::text);


--
-- Name: adaptive_reflexes_agent_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_reflexes_agent_status_idx ON public.adaptive_reflexes USING btree (agent, status, last_seen_at DESC);


--
-- Name: adaptive_rpe_reflex_harvests_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_rpe_reflex_harvests_agent_time_idx ON public.adaptive_rpe_reflex_harvests USING btree (agent, created_at DESC);


--
-- Name: adaptive_rpe_reflex_harvests_reflex_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX adaptive_rpe_reflex_harvests_reflex_idx ON public.adaptive_rpe_reflex_harvests USING btree (reflex_id, created_at DESC);


--
-- Name: allostatic_samples_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX allostatic_samples_state_idx ON public.allostatic_samples USING btree (state, sampled_at DESC);


--
-- Name: allostatic_samples_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX allostatic_samples_time_idx ON public.allostatic_samples USING btree (sampled_at DESC);


--
-- Name: brain_receipt_challenges_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brain_receipt_challenges_lookup ON public.brain_receipt_challenges USING btree (agent, harness_session_id, status, expires_at DESC);


--
-- Name: brain_receipt_challenges_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX brain_receipt_challenges_uniq ON public.brain_receipt_challenges USING btree (agent, harness_session_id, challenge_id);


--
-- Name: claims_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claims_content_id_idx ON public.claims USING btree (content_id);


--
-- Name: claims_target_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claims_target_idx ON public.claims USING btree (target);


--
-- Name: claims_unverified_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX claims_unverified_idx ON public.claims USING btree (verified, claimed_at DESC) WHERE (verified = false);


--
-- Name: entities_name_lower_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX entities_name_lower_key ON public.entities USING btree (lower(name));


--
-- Name: evolution_pressure_events_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX evolution_pressure_events_agent_time_idx ON public.evolution_pressure_events USING btree (agent, created_at DESC);


--
-- Name: evolution_pressure_events_clearance_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX evolution_pressure_events_clearance_idx ON public.evolution_pressure_events USING btree (clearance, created_at DESC);


--
-- Name: felt_threat_gate_decisions_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_agent_time_idx ON public.felt_threat_gate_decisions USING btree (agent, created_at DESC);


--
-- Name: felt_threat_gate_decisions_authority_drift_fields_gin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_authority_drift_fields_gin_idx ON public.felt_threat_gate_decisions USING gin (authority_drift_fields);


--
-- Name: felt_threat_gate_decisions_authority_drift_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_authority_drift_idx ON public.felt_threat_gate_decisions USING btree (authority_drift, resolved_at DESC);


--
-- Name: felt_threat_gate_decisions_authority_drift_severity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_authority_drift_severity_idx ON public.felt_threat_gate_decisions USING btree (authority_drift_severity DESC, resolved_at DESC);


--
-- Name: felt_threat_gate_decisions_authority_duration_bucket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_authority_duration_bucket_idx ON public.felt_threat_gate_decisions USING btree (authority_observation_duration_bucket, resolved_at DESC) WHERE (authority_observation_duration_bucket IS NOT NULL);


--
-- Name: felt_threat_gate_decisions_authority_duration_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_authority_duration_idx ON public.felt_threat_gate_decisions USING btree (authority_observation_duration_ms DESC, resolved_at DESC) WHERE (authority_observation_duration_ms IS NOT NULL);


--
-- Name: felt_threat_gate_decisions_authority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_authority_idx ON public.felt_threat_gate_decisions USING btree (((effective_gate_authority ->> 'effective_precedence'::text)), created_at DESC);


--
-- Name: felt_threat_gate_decisions_cross_scan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_cross_scan_idx ON public.felt_threat_gate_decisions USING btree (last_cross_organ_scan_at, resolved_at DESC);


--
-- Name: felt_threat_gate_decisions_observation_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_observation_key_idx ON public.felt_threat_gate_decisions USING btree (observation_key) WHERE (observation_key IS NOT NULL);


--
-- Name: felt_threat_gate_decisions_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_outcome_idx ON public.felt_threat_gate_decisions USING btree (decision_outcome, resolved_at DESC);


--
-- Name: felt_threat_gate_decisions_path_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_path_time_idx ON public.felt_threat_gate_decisions USING btree (gate_path, created_at DESC);


--
-- Name: felt_threat_gate_decisions_presence_deferred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_presence_deferred_idx ON public.felt_threat_gate_decisions USING btree (agent, created_at DESC) WHERE (gate_path = 'presence_deferred'::text);


--
-- Name: felt_threat_gate_decisions_trace_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_gate_decisions_trace_key_idx ON public.felt_threat_gate_decisions USING btree (action_trace_key) WHERE (action_trace_key IS NOT NULL);


--
-- Name: felt_threat_observations_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_observations_agent_time_idx ON public.felt_threat_observations USING btree (agent, created_at DESC);


--
-- Name: felt_threat_observations_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_observations_live_idx ON public.felt_threat_observations USING btree (is_synthetic, created_at DESC);


--
-- Name: felt_threat_observations_open_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX felt_threat_observations_open_key_idx ON public.felt_threat_observations USING btree (agent, observation_key) WHERE ((observation_key IS NOT NULL) AND (resolved_at IS NULL));


--
-- Name: felt_threat_observations_outcome_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_observations_outcome_idx ON public.felt_threat_observations USING btree (observation_outcome, resolved_at DESC);


--
-- Name: felt_threat_outcomes_action_change_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_outcomes_action_change_idx ON public.felt_threat_outcomes USING btree (did_action_change, resolved_at DESC);


--
-- Name: felt_threat_outcomes_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_outcomes_agent_time_idx ON public.felt_threat_outcomes USING btree (agent, created_at DESC);


--
-- Name: felt_threat_outcomes_cross_scan_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_outcomes_cross_scan_idx ON public.felt_threat_outcomes USING btree (last_cross_organ_scan_at, resolved_at DESC);


--
-- Name: felt_threat_outcomes_resolution_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_outcomes_resolution_idx ON public.felt_threat_outcomes USING btree (resolution, resolved_at DESC);


--
-- Name: felt_threat_outcomes_synthetic_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_outcomes_synthetic_idx ON public.felt_threat_outcomes USING btree (is_synthetic, resolved_at DESC);


--
-- Name: felt_threat_outcomes_trace_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX felt_threat_outcomes_trace_key_idx ON public.felt_threat_outcomes USING btree (action_trace_key);


--
-- Name: forward_predictions_surprise_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forward_predictions_surprise_idx ON public.forward_predictions USING btree (surprise DESC) WHERE (surprise IS NOT NULL);


--
-- Name: forward_predictions_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forward_predictions_time_idx ON public.forward_predictions USING btree (predicted_at DESC);


--
-- Name: forward_predictions_tool_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forward_predictions_tool_idx ON public.forward_predictions USING btree (tool_name, predicted_at DESC);


--
-- Name: forward_predictions_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX forward_predictions_unresolved_idx ON public.forward_predictions USING btree (predicted_at DESC) WHERE (resolved_at IS NULL);


--
-- Name: gut_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gut_content_id_idx ON public.gut_signals USING btree (content_id);


--
-- Name: gut_signal_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gut_signal_type_idx ON public.gut_signals USING btree (signal_type, sensed_at DESC);


--
-- Name: gut_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX gut_unresolved_idx ON public.gut_signals USING btree (resolved_as, sensed_at DESC) WHERE (resolved_as IS NULL);


--
-- Name: idx_access_log_content; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_log_content ON public.memory_access_log USING btree (content_id);


--
-- Name: idx_access_log_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_log_session ON public.memory_access_log USING btree (session_id);


--
-- Name: idx_access_log_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_access_log_time ON public.memory_access_log USING btree (accessed_at);


--
-- Name: idx_activation_log_content_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_log_content_id ON public.activation_log USING btree (content_id);


--
-- Name: idx_activation_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activation_log_created_at ON public.activation_log USING btree (created_at);


--
-- Name: idx_alignment_checks_aligned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alignment_checks_aligned ON public.alignment_checks USING btree (aligned);


--
-- Name: idx_alignment_checks_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alignment_checks_session ON public.alignment_checks USING btree (session_id);


--
-- Name: idx_anticipations_trigger; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anticipations_trigger ON public.anticipations USING btree (trigger_event);


--
-- Name: idx_anticipatory_states_resolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_anticipatory_states_resolved ON public.anticipatory_states USING btree (resolved_at);


--
-- Name: idx_ask_vs_act_unscored; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ask_vs_act_unscored ON public.ask_vs_act_log USING btree (decided_at) WHERE (verdict IS NULL);


--
-- Name: idx_beliefs_audit_op_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beliefs_audit_op_id ON public.beliefs_audit USING btree (op_id);


--
-- Name: idx_beliefs_audit_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_beliefs_audit_run_id ON public.beliefs_audit USING btree (run_id);


--
-- Name: idx_biology_cycles_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_biology_cycles_created ON public.biology_cycles USING btree (created_at DESC);


--
-- Name: idx_biology_cycles_phase; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_biology_cycles_phase ON public.biology_cycles USING btree (cycle_phase, created_at DESC);


--
-- Name: idx_blind_spot_slices_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blind_spot_slices_slug ON public.blind_spot_slices USING btree (slice_slug);


--
-- Name: idx_blind_spot_slices_xarch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blind_spot_slices_xarch ON public.blind_spot_slices USING btree (cross_architecture);


--
-- Name: idx_brain_receipts_agent_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brain_receipts_agent_session ON public.brain_receipts USING btree (agent, session_id, expires_at DESC);


--
-- Name: idx_calibration_bins_bin_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_calibration_bins_bin_domain ON public.calibration_bins USING btree (bin_lower, bin_upper, domain);


--
-- Name: idx_callus_rule_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_callus_rule_name ON public.callus_events USING btree (rule_name);


--
-- Name: idx_callus_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_callus_unresolved ON public.callus_events USING btree (rule_name) WHERE (behavior_changed_at IS NULL);


--
-- Name: idx_clipboard_events_ts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_clipboard_events_ts ON public.clipboard_events USING btree (ts DESC);


--
-- Name: idx_coherence_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coherence_time ON public.narrative_coherence_checks USING btree (checked_at DESC);


--
-- Name: idx_content_accessed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_accessed ON public.content USING btree (accessed_at DESC NULLS LAST) WHERE (superseded_by IS NULL);


--
-- Name: idx_content_consolidation_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_consolidation_strength ON public.content USING btree (consolidation_strength);


--
-- Name: idx_content_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_created ON public.content USING btree (created_at DESC);


--
-- Name: idx_content_created_emotional; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_created_emotional ON public.content USING btree (created_at DESC, emotional_intensity) WHERE (superseded_by IS NULL);


--
-- Name: idx_content_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_embedding ON public.content USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_content_emotional_intensity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_emotional_intensity ON public.content USING btree (emotional_intensity) WHERE (emotional_intensity IS NOT NULL);


--
-- Name: idx_content_event_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_event_at ON public.content USING btree (event_at) WHERE (event_at IS NOT NULL);


--
-- Name: idx_content_json; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_json ON public.content USING gin (content_json);


--
-- Name: idx_content_learned_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_learned_at ON public.content USING btree (learned_at);


--
-- Name: idx_content_network; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_network ON public.content USING btree (network);


--
-- Name: idx_content_network_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_network_active ON public.content USING btree (network) WHERE (superseded_by IS NULL);


--
-- Name: idx_content_referenced_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_referenced_at ON public.content USING btree (referenced_at) WHERE (referenced_at IS NOT NULL);


--
-- Name: idx_content_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_source ON public.content USING btree (source_system);


--
-- Name: idx_content_text_search; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_text_search ON public.content USING gin (to_tsvector('english'::regconfig, content_text));


--
-- Name: idx_content_text_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_text_trgm ON public.content USING gin (content_text public.gin_trgm_ops);


--
-- Name: idx_content_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_type ON public.content USING btree (content_type);


--
-- Name: idx_content_type_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_content_type_active ON public.content USING btree (content_type) WHERE (superseded_by IS NULL);


--
-- Name: idx_desire_cues_strength; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_desire_cues_strength ON public.desire_cues USING btree (strength);


--
-- Name: idx_done_claims_unverified; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_done_claims_unverified ON public.done_claims USING btree (claimed_at) WHERE (NOT verified);


--
-- Name: idx_ecm_content; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ecm_content ON public.entity_content_mentions USING btree (content_id);


--
-- Name: idx_ecm_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ecm_entity ON public.entity_content_mentions USING btree (entity_id);


--
-- Name: idx_embedding_cache_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_embedding_cache_hash ON public.embedding_cache USING btree (text_hash);


--
-- Name: idx_emotional_consolidation_events_content_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emotional_consolidation_events_content_id ON public.emotional_consolidation_events USING btree (content_id);


--
-- Name: idx_energy_boosts_impact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_energy_boosts_impact ON public.energy_boosts USING btree (impact DESC);


--
-- Name: idx_energy_checkins_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_energy_checkins_session ON public.energy_checkins USING btree (session_id);


--
-- Name: idx_energy_drains_impact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_energy_drains_impact ON public.energy_drains USING btree (impact DESC);


--
-- Name: idx_engram_members_content; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_engram_members_content ON public.engram_members USING btree (content_id);


--
-- Name: idx_entity_rel_confidence; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_rel_confidence ON public.entity_relationships USING btree (confidence) WHERE (confidence < (0.5)::double precision);


--
-- Name: idx_entity_rel_temporal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_rel_temporal ON public.entity_relationships USING btree (valid_from, valid_until) WHERE (valid_until IS NOT NULL);


--
-- Name: idx_entity_rel_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_entity_rel_type ON public.entity_relationships USING btree (relation_type) WHERE (valid_until IS NULL);


--
-- Name: idx_entity_rel_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_entity_rel_unique ON public.entity_relationships USING btree (from_entity_id, to_entity_id, relation_type) WHERE (valid_until IS NULL);


--
-- Name: idx_expectations_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expectations_active ON public.expectations USING btree (active);


--
-- Name: idx_expectations_context; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expectations_context ON public.expectations USING btree (context);


--
-- Name: idx_expressions_reception; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_expressions_reception ON public.expressions USING btree (reception);


--
-- Name: idx_feelings_feeling; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feelings_feeling ON public.feelings USING btree (feeling);


--
-- Name: idx_feelings_intensity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_feelings_intensity ON public.feelings USING btree (intensity);


--
-- Name: idx_focus_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_focus_events_session ON public.focus_events USING btree (session_id);


--
-- Name: idx_focus_events_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_focus_events_type ON public.focus_events USING btree (target_type);


--
-- Name: idx_frustrations_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_frustrations_severity ON public.frustrations USING btree (severity DESC);


--
-- Name: idx_glymphatic_residue_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_glymphatic_residue_open ON public.glymphatic_residue USING btree (detected_at DESC) WHERE (status = 'open'::text);


--
-- Name: idx_glymphatic_residue_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_glymphatic_residue_source ON public.glymphatic_residue USING btree (source_table, source_id, residue_type);


--
-- Name: idx_graph_audit_op_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_audit_op_id ON public.graph_audit USING btree (op_id);


--
-- Name: idx_graph_audit_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_audit_run_id ON public.graph_audit USING btree (run_id);


--
-- Name: idx_graph_edges_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_edges_from ON public.graph_edges USING btree (from_entity);


--
-- Name: idx_graph_edges_rel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_edges_rel ON public.graph_edges USING btree (relationship);


--
-- Name: idx_graph_edges_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_graph_edges_to ON public.graph_edges USING btree (to_entity);


--
-- Name: idx_graph_edges_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_graph_edges_unique ON public.graph_edges USING btree (from_entity, to_entity, relationship);


--
-- Name: idx_gratitudes_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gratitudes_category ON public.gratitudes USING btree (category);


--
-- Name: idx_gratitudes_intensity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_gratitudes_intensity ON public.gratitudes USING btree (intensity);


--
-- Name: idx_habit_events_habit; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_habit_events_habit ON public.habit_events USING btree (habit_type, habit_id);


--
-- Name: idx_habit_events_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_habit_events_time ON public.habit_events USING btree (created_at);


--
-- Name: idx_habit_triggers_type_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_habit_triggers_type_value ON public.habit_triggers USING btree (trigger_type, trigger_value);


--
-- Name: idx_hard_limits_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hard_limits_category ON public.hard_limits USING btree (category);


--
-- Name: idx_hippocampus_buffer_unarchived; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hippocampus_buffer_unarchived ON public.hippocampus_buffer USING btree (created_at) WHERE (archived_at IS NULL);


--
-- Name: idx_identity_threads_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_threads_domain ON public.narrative_identity_threads USING btree (domain);


--
-- Name: idx_identity_threads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_identity_threads_status ON public.narrative_identity_threads USING btree (status);


--
-- Name: idx_immune_audit_op_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_immune_audit_op_id ON public.immune_audit USING btree (op_id);


--
-- Name: idx_immune_audit_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_immune_audit_run_id ON public.immune_audit USING btree (run_id);


--
-- Name: idx_immune_tolerance_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_immune_tolerance_created ON public.immune_tolerance_decisions USING btree (created_at DESC);


--
-- Name: idx_immune_tolerance_decision; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_immune_tolerance_decision ON public.immune_tolerance_decisions USING btree (decision, created_at DESC);


--
-- Name: idx_inner_obs_pulse; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inner_obs_pulse ON public.inner_observations USING btree (pulse_id);


--
-- Name: idx_inner_pulses_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_inner_pulses_time ON public.inner_pulses USING btree (created_at);


--
-- Name: idx_integration_debt_dark; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_debt_dark ON public.integration_debt USING btree (organ_name) WHERE dark_flag;


--
-- Name: idx_integration_debt_organ; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_integration_debt_organ ON public.integration_debt USING btree (organ_name);


--
-- Name: idx_intent_sessions_started; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intent_sessions_started ON public.intent_sessions USING btree (started_at DESC);


--
-- Name: idx_intentions_unresolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_intentions_unresolved ON public.intentions USING btree (created_at) WHERE (resolved_at IS NULL);


--
-- Name: idx_interoceptive_forecasts_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_interoceptive_forecasts_created ON public.interoceptive_forecasts USING btree (created_at DESC);


--
-- Name: idx_interoceptive_forecasts_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_interoceptive_forecasts_open ON public.interoceptive_forecasts USING btree (created_at DESC) WHERE (status = 'open'::text);


--
-- Name: idx_library_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_source ON public.library_entries USING btree (source_ref);


--
-- Name: idx_library_source_type; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_library_source_type ON public.library_entries USING btree (entry_type, source_ref);


--
-- Name: idx_library_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_library_type ON public.library_entries USING btree (entry_type);


--
-- Name: idx_lifecycle_decay_log_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_decay_log_action ON public.lifecycle_decay_log USING btree (action);


--
-- Name: idx_lifecycle_decay_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_decay_log_created_at ON public.lifecycle_decay_log USING btree (created_at DESC);


--
-- Name: idx_lifecycle_decay_log_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lifecycle_decay_log_run_id ON public.lifecycle_decay_log USING btree (run_id);


--
-- Name: idx_loop_cycles_env; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loop_cycles_env ON public.loop_cycles USING btree (env_id);


--
-- Name: idx_loop_iterations_cycle; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_loop_iterations_cycle ON public.loop_iterations USING btree (cycle_id);


--
-- Name: idx_memories_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memories_created_at ON public.memories USING btree (created_at DESC);


--
-- Name: idx_memory_edges_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_edges_active ON public.memory_edges USING btree (from_content_id, to_content_id) WHERE (superseded_at IS NULL);


--
-- Name: idx_memory_edges_emotional_weight; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_edges_emotional_weight ON public.memory_edges USING btree (emotional_weight) WHERE (emotional_weight > (0)::double precision);


--
-- Name: idx_memory_edges_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_edges_from ON public.memory_edges USING btree (from_content_id);


--
-- Name: idx_memory_edges_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_edges_to ON public.memory_edges USING btree (to_content_id);


--
-- Name: idx_memory_edges_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_memory_edges_type ON public.memory_edges USING btree (relation_type);


--
-- Name: idx_meta_observations_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meta_observations_kind ON public.meta_observations USING btree (gap_kind);


--
-- Name: idx_meta_observations_observed_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_meta_observations_observed_at ON public.meta_observations USING btree (observed_at DESC);


--
-- Name: idx_milestones_goal; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_milestones_goal ON public.milestones USING btree (goal_id);


--
-- Name: idx_narrative_conflicts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_conflicts_status ON public.narrative_conflicts USING btree (status);


--
-- Name: idx_narrative_episodes_arc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_episodes_arc ON public.narrative_episodes USING btree (arc_id);


--
-- Name: idx_narrative_primed_resolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_primed_resolved ON public.narrative_primed USING btree (resolved_at);


--
-- Name: idx_narrative_segments_context; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_segments_context ON public.narrative_segments USING btree (context);


--
-- Name: idx_narrative_segments_episode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_segments_episode ON public.narrative_segments USING btree (episode_id);


--
-- Name: idx_narrative_segments_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_segments_time ON public.narrative_segments USING btree (started_at DESC);


--
-- Name: idx_narrative_threads_activation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_threads_activation ON public.narrative_threads USING btree (activation);


--
-- Name: idx_narrative_threads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_narrative_threads_status ON public.narrative_threads USING btree (status);


--
-- Name: idx_needs_likelihood; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_needs_likelihood ON public.needs_forecast USING btree (likelihood DESC);


--
-- Name: idx_observables_claim; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_observables_claim ON public.verification_observables USING btree (claim_id);


--
-- Name: idx_organ_vitality_sampled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_organ_vitality_sampled ON public.organ_vitality USING btree (sampled_at DESC);


--
-- Name: idx_patterns_pattern; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_patterns_pattern ON public.patterns_observed USING btree (pattern);


--
-- Name: idx_patterns_type_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_patterns_type_desc ON public.patterns_observed USING btree (pattern_type, description) WHERE (pattern_type IS NOT NULL);


--
-- Name: idx_phase4_validator_log_caller; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phase4_validator_log_caller ON public.phase4_validator_log USING btree (caller);


--
-- Name: idx_phase4_validator_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phase4_validator_log_created_at ON public.phase4_validator_log USING btree (created_at DESC);


--
-- Name: idx_phase4_validator_log_mode_verdict; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phase4_validator_log_mode_verdict ON public.phase4_validator_log USING btree (mode, verdict);


--
-- Name: idx_phase4_validator_log_stem; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phase4_validator_log_stem ON public.phase4_validator_log USING btree (stem_score) WHERE (stem_score IS NOT NULL);


--
-- Name: idx_phase4_validator_log_verdict; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_phase4_validator_log_verdict ON public.phase4_validator_log USING btree (verdict);


--
-- Name: idx_possible_selves_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_possible_selves_active ON public.narrative_possible_selves USING btree (is_active);


--
-- Name: idx_possible_selves_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_possible_selves_type ON public.narrative_possible_selves USING btree (type);


--
-- Name: idx_prediction_errors_content_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prediction_errors_content_id ON public.prediction_errors USING btree (content_id);


--
-- Name: idx_prediction_errors_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prediction_errors_created_at ON public.prediction_errors USING btree (created_at);


--
-- Name: idx_predictions_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_predictions_domain ON public.predictions USING btree (domain);


--
-- Name: idx_predictions_resolved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_predictions_resolved ON public.predictions USING btree (resolved);


--
-- Name: idx_preferences_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_preferences_category ON public.preferences USING btree (category);


--
-- Name: idx_prod_deploys_host_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prod_deploys_host_time ON public.prod_deploys USING btree (host, deployed_at DESC);


--
-- Name: idx_prod_deploys_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prod_deploys_recent ON public.prod_deploys USING btree (deployed_at DESC);


--
-- Name: idx_relay_audit_op_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relay_audit_op_id ON public.relay_audit USING btree (op_id);


--
-- Name: idx_relay_audit_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_relay_audit_run_id ON public.relay_audit USING btree (run_id);


--
-- Name: idx_replay_episodes_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_replay_episodes_created ON public.replay_episodes USING btree (created_at DESC);


--
-- Name: idx_replay_episodes_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_replay_episodes_type ON public.replay_episodes USING btree (replay_type, created_at DESC);


--
-- Name: idx_research_claims_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_research_claims_thread ON public.research_claims USING btree (thread_id, kind);


--
-- Name: idx_research_log_thread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_research_log_thread ON public.research_log USING btree (thread_id, logged_at DESC);


--
-- Name: idx_responsibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_responsibility ON public.responsibility_map USING btree (my_responsibility);


--
-- Name: idx_salience_filters_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_salience_filters_type ON public.salience_filters USING btree (filter_type);


--
-- Name: idx_seeking_ended; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_seeking_ended ON public.seeking_episodes USING btree (ended_at);


--
-- Name: idx_self_defining_episode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_defining_episode ON public.narrative_self_defining_memories USING btree (episode_id);


--
-- Name: idx_self_defining_retrieved; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_self_defining_retrieved ON public.narrative_self_defining_memories USING btree (last_retrieved_at DESC);


--
-- Name: idx_session_times_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_session_times_day ON public.session_times USING btree (day_of_week);


--
-- Name: idx_shared_history_weight; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shared_history_weight ON public.shared_history USING btree (emotional_weight DESC);


--
-- Name: idx_skill_triggers_type_value; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_triggers_type_value ON public.skill_triggers USING btree (trigger_type, trigger_value);


--
-- Name: idx_skill_usage_outcome; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_usage_outcome ON public.skill_usage_log USING btree (outcome);


--
-- Name: idx_skill_usage_skill_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_skill_usage_skill_id ON public.skill_usage_log USING btree (skill_id);


--
-- Name: idx_slack_freedoms_dimension; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slack_freedoms_dimension ON public.slack_freedoms USING btree (dimension);


--
-- Name: idx_slack_freedoms_task; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_slack_freedoms_task ON public.slack_freedoms USING btree (task_id);


--
-- Name: idx_spiral_log_kind; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spiral_log_kind ON public.spiral_log USING btree (ring_kind);


--
-- Name: idx_spiral_log_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spiral_log_occurred_at ON public.spiral_log USING btree (occurred_at DESC);


--
-- Name: idx_spiral_log_phase; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_spiral_log_phase ON public.spiral_log USING btree (phase);


--
-- Name: idx_stage_events_occurred_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stage_events_occurred_at ON public.stage_events USING btree (occurred_at DESC);


--
-- Name: idx_stage_events_response; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stage_events_response ON public.stage_events USING btree (response_kind);


--
-- Name: idx_stage_events_voiced; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stage_events_voiced ON public.stage_events USING btree (occurred_at DESC) WHERE (response_kind = 'voice'::text);


--
-- Name: idx_stage_events_wire; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stage_events_wire ON public.stage_events USING btree (wire);


--
-- Name: idx_synaptic_pruning_content; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synaptic_pruning_content ON public.synaptic_pruning_candidates USING btree (content_id);


--
-- Name: idx_synaptic_pruning_open; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_synaptic_pruning_open ON public.synaptic_pruning_candidates USING btree (created_at DESC) WHERE (status = 'open'::text);


--
-- Name: idx_tasting_notes_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasting_notes_created ON public.tasting_notes USING btree (created_at DESC);


--
-- Name: idx_tasting_notes_rating; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tasting_notes_rating ON public.tasting_notes USING btree (rating);


--
-- Name: idx_time_patterns_tod; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_time_patterns_tod ON public.time_patterns USING btree (time_of_day);


--
-- Name: idx_token_spends_agent_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_spends_agent_time ON public.token_spends USING btree (spent_for_agent, spent_at DESC);


--
-- Name: idx_token_spends_gate_decision; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_spends_gate_decision ON public.token_spends USING btree (gate_decision, spent_at DESC);


--
-- Name: idx_token_spends_token_turn; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_spends_token_turn ON public.token_spends USING btree (token_id, turn_id);


--
-- Name: idx_tokens_capability_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tokens_capability_active ON public.tokens USING btree (capability, granted_for_agent, expires_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: idx_tokens_granted_for_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tokens_granted_for_agent ON public.tokens USING btree (granted_for_agent, granted_at DESC);


--
-- Name: idx_tokens_macaroon_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tokens_macaroon_id ON public.tokens USING btree (macaroon_id);


--
-- Name: idx_tokens_proof_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tokens_proof_hash ON public.tokens USING btree (proof_hash);


--
-- Name: idx_tone_effectiveness; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tone_effectiveness ON public.tone_experiments USING btree (effectiveness);


--
-- Name: idx_tool_invocations_agent_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_agent_time ON public.tool_invocations USING btree (agent, invoked_at DESC);


--
-- Name: idx_tool_invocations_daily_tool; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_daily_tool ON public.tool_invocations_daily USING btree (tool_name, day DESC);


--
-- Name: idx_tool_invocations_errors; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_errors ON public.tool_invocations USING btree (tool_name, invoked_at DESC) WHERE (error IS NOT NULL);


--
-- Name: idx_tool_invocations_invoked_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_invoked_at ON public.tool_invocations USING btree (invoked_at DESC);


--
-- Name: idx_tool_invocations_span_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_span_id ON public.tool_invocations USING btree (span_id);


--
-- Name: idx_tool_invocations_tool_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tool_invocations_tool_time ON public.tool_invocations USING btree (tool_name, invoked_at DESC);


--
-- Name: idx_trust_direction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trust_direction ON public.trust_moments USING btree (direction);


--
-- Name: idx_trusted_mode_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trusted_mode_active ON public.trusted_mode_sessions USING btree (agent, expires_at DESC) WHERE (revoked_at IS NULL);


--
-- Name: idx_urges_intensity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_urges_intensity ON public.urges USING btree (intensity DESC);


--
-- Name: idx_urges_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_urges_status ON public.urges USING btree (acted_on, suppressed);


--
-- Name: idx_vault_audit_op_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vault_audit_op_id ON public.vault_audit USING btree (op_id);


--
-- Name: idx_vault_audit_run_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_vault_audit_run_id ON public.vault_audit USING btree (run_id);


--
-- Name: idx_veritas_findings_detector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_veritas_findings_detector ON public.veritas_findings USING btree (detector);


--
-- Name: idx_veritas_findings_tier_detected; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_veritas_findings_tier_detected ON public.veritas_findings USING btree (tier, detected_at DESC);


--
-- Name: idx_veritas_findings_transcript; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_veritas_findings_transcript ON public.veritas_findings USING btree (transcript_path);


--
-- Name: idx_wander_choices_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wander_choices_session ON public.wander_choice_points USING btree (session_id);


--
-- Name: idx_wander_patterns_freq; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wander_patterns_freq ON public.wander_emergent_patterns USING btree (frequency DESC);


--
-- Name: idx_wander_quests_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wander_quests_session ON public.wander_side_quests USING btree (session_id);


--
-- Name: idx_world_entities_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_world_entities_status ON public.world_entities USING btree (status);


--
-- Name: idx_world_entities_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_world_entities_type ON public.world_entities USING btree (type);


--
-- Name: idx_world_properties_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_world_properties_entity ON public.world_properties USING btree (entity_id);


--
-- Name: idx_world_properties_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_world_properties_key ON public.world_properties USING btree (key);


--
-- Name: idx_world_relationships_from; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_world_relationships_from ON public.world_relationships USING btree (from_entity);


--
-- Name: idx_world_relationships_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_world_relationships_to ON public.world_relationships USING btree (to_entity);


--
-- Name: lc_samples_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lc_samples_active_idx ON public.lc_samples USING btree (sampled_at DESC) WHERE (mode = 'phasic'::text);


--
-- Name: lc_samples_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lc_samples_mode_idx ON public.lc_samples USING btree (mode, sampled_at DESC);


--
-- Name: lc_samples_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX lc_samples_time_idx ON public.lc_samples USING btree (sampled_at DESC);


--
-- Name: memory_importance_composite_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_importance_composite_idx ON public.memory_importance USING btree (composite_score DESC);


--
-- Name: memory_importance_scored_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX memory_importance_scored_at_idx ON public.memory_importance USING btree (scored_at);


--
-- Name: miss_calibrations_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX miss_calibrations_domain_idx ON public.miss_calibrations USING btree (agent, domain, created_at DESC);


--
-- Name: neuroception_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX neuroception_content_id_idx ON public.neuroception_states USING btree (content_id);


--
-- Name: neuroception_current_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX neuroception_current_idx ON public.neuroception_states USING btree (entered_at DESC) WHERE (exited_at IS NULL);


--
-- Name: neuroception_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX neuroception_state_idx ON public.neuroception_states USING btree (state, entered_at DESC);


--
-- Name: neurocognitive_cycles_agent_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX neurocognitive_cycles_agent_time_idx ON public.neurocognitive_cycles USING btree (agent, created_at DESC);


--
-- Name: neurocognitive_cycles_mode_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX neurocognitive_cycles_mode_idx ON public.neurocognitive_cycles USING btree (mode, created_at DESC);


--
-- Name: patience_events_agent_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patience_events_agent_domain_idx ON public.patience_events USING btree (agent, domain, created_at DESC);


--
-- Name: patience_events_unresolved_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX patience_events_unresolved_idx ON public.patience_events USING btree (agent, outcome) WHERE (outcome IS NULL);


--
-- Name: phase_gate_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX phase_gate_active_idx ON public.phase_gate USING btree (session_id) WHERE (exited_at IS NULL);


--
-- Name: phase_gate_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX phase_gate_session_idx ON public.phase_gate USING btree (session_id, entered_at DESC);


--
-- Name: phase_gate_violations_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX phase_gate_violations_session_idx ON public.phase_gate_violations USING btree (session_id, occurred_at DESC);


--
-- Name: presence_events_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX presence_events_pending_idx ON public.presence_events USING btree (verification_outcome) WHERE (closed_at IS NOT NULL);


--
-- Name: presence_events_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX presence_events_session_idx ON public.presence_events USING btree (session_id, entered_at);


--
-- Name: priority_alerts_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX priority_alerts_content_id_idx ON public.priority_alerts USING btree (content_id);


--
-- Name: priority_alerts_system_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX priority_alerts_system_idx ON public.priority_alerts USING btree (system_name, created_at DESC);


--
-- Name: priority_alerts_unattended_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX priority_alerts_unattended_idx ON public.priority_alerts USING btree (effective_weight DESC, created_at DESC) WHERE (attended = false);


--
-- Name: rhythm_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rhythm_content_id_idx ON public.rhythm_samples USING btree (content_id);


--
-- Name: rhythm_phase_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rhythm_phase_idx ON public.rhythm_samples USING btree (phase, sampled_at DESC);


--
-- Name: rhythm_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rhythm_session_idx ON public.rhythm_samples USING btree (session_id, sampled_at);


--
-- Name: rpe_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rpe_domain_idx ON public.reward_prediction_errors USING btree (domain, computed_at DESC);


--
-- Name: rpe_magnitude_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rpe_magnitude_idx ON public.reward_prediction_errors USING btree (magnitude DESC);


--
-- Name: rpe_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rpe_source_idx ON public.reward_prediction_errors USING btree (source_type, source_id);


--
-- Name: rpe_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX rpe_time_idx ON public.reward_prediction_errors USING btree (computed_at DESC);


--
-- Name: salient_events_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salient_events_content_id_idx ON public.salient_events USING btree (content_id);


--
-- Name: salient_events_score_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX salient_events_score_idx ON public.salient_events USING btree (salience_score DESC);


--
-- Name: satisfactions_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX satisfactions_content_id_idx ON public.satisfactions USING btree (content_id);


--
-- Name: satisfactions_want_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX satisfactions_want_idx ON public.satisfactions USING btree (want_id);


--
-- Name: schema_instances_content_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schema_instances_content_idx ON public.schema_instances USING btree (content_id);


--
-- Name: schema_instances_schema_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX schema_instances_schema_idx ON public.schema_instances USING btree (schema_id);


--
-- Name: sessions_last_activity_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_last_activity_index ON public.sessions USING btree (last_activity);


--
-- Name: sessions_user_id_index; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_id_index ON public.sessions USING btree (user_id);


--
-- Name: sibling_state_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sibling_state_latest_idx ON public.sibling_state USING btree (observer, sibling, created_at DESC);


--
-- Name: sibling_state_verdict_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sibling_state_verdict_idx ON public.sibling_state USING btree (sibling, verdict, created_at DESC);


--
-- Name: slack_readings_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX slack_readings_content_id_idx ON public.slack_readings USING btree (content_id);


--
-- Name: slack_readings_dimension_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX slack_readings_dimension_idx ON public.slack_readings USING btree (dimension, read_at DESC);


--
-- Name: slack_readings_task_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX slack_readings_task_idx ON public.slack_readings USING btree (task, read_at DESC);


--
-- Name: vision_capability_runs_latest_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_capability_runs_latest_idx ON public.vision_capability_probe_runs USING btree (agent_name, agent_db, ran_at DESC);


--
-- Name: vision_capability_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_capability_runs_status_idx ON public.vision_capability_probe_runs USING btree (status, ran_at DESC);


--
-- Name: vision_eval_cases_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_eval_cases_priority_idx ON public.vision_eval_cases USING btree (priority, created_at DESC) WHERE (status = 'active'::text);


--
-- Name: vision_eval_cases_suite_capability_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_eval_cases_suite_capability_idx ON public.vision_eval_cases USING btree (suite, capability, status);


--
-- Name: vision_eval_results_case_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_eval_results_case_time_idx ON public.vision_eval_results USING btree (case_id, evaluated_at DESC);


--
-- Name: vision_eval_results_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_eval_results_run_idx ON public.vision_eval_results USING btree (run_id);


--
-- Name: vision_eval_results_verdict_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_eval_results_verdict_idx ON public.vision_eval_results USING btree (verdict, evaluated_at DESC);


--
-- Name: vision_eval_runs_suite_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vision_eval_runs_suite_time_idx ON public.vision_eval_runs USING btree (suite, started_at DESC);


--
-- Name: voice_audit_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_audit_session_idx ON public.voice_audit USING btree (session_id);


--
-- Name: voice_audit_unack_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX voice_audit_unack_idx ON public.voice_audit USING btree (detected_at DESC) WHERE (acknowledged_at IS NULL);


--
-- Name: wants_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wants_active_idx ON public.wants USING btree (last_activated DESC) WHERE (satisfied_at IS NULL);


--
-- Name: wants_content_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wants_content_id_idx ON public.wants USING btree (content_id);


--
-- Name: wants_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wants_domain_idx ON public.wants USING btree (domain, last_activated DESC);


--
-- Name: wm_binding_members_binding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wm_binding_members_binding_idx ON public.working_memory_binding_members USING btree (binding_id);


--
-- Name: wm_binding_members_content_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wm_binding_members_content_idx ON public.working_memory_binding_members USING btree (content_id);


--
-- Name: wm_bindings_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wm_bindings_active_idx ON public.working_memory_bindings USING btree (released_at) WHERE (released_at IS NULL);


--
-- Name: wm_bindings_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX wm_bindings_expiry_idx ON public.working_memory_bindings USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (released_at IS NULL));


--
-- Name: content content_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER content_updated_at BEFORE UPDATE ON public.content FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: allostatic_samples trg_auto_gut_from_allostatic; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_gut_from_allostatic AFTER INSERT ON public.allostatic_samples FOR EACH ROW EXECUTE FUNCTION public.auto_gut_from_allostatic_strain();


--
-- Name: content trg_auto_link_content; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_link_content AFTER INSERT ON public.content FOR EACH ROW EXECUTE FUNCTION public.auto_link_similar_content();


--
-- Name: gut_signals trg_auto_salience_gut; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_salience_gut AFTER INSERT ON public.gut_signals FOR EACH ROW EXECUTE FUNCTION public.auto_salience_from_gut();


--
-- Name: content trg_auto_salience_novelty; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_salience_novelty AFTER INSERT ON public.content FOR EACH ROW EXECUTE FUNCTION public.auto_salience_from_novelty();


--
-- Name: prediction_errors trg_auto_salience_pred_err; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_salience_pred_err AFTER INSERT ON public.prediction_errors FOR EACH ROW EXECUTE FUNCTION public.auto_salience_from_pred_err();


--
-- Name: reward_prediction_errors trg_auto_salience_rpe; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_auto_salience_rpe AFTER INSERT ON public.reward_prediction_errors FOR EACH ROW EXECUTE FUNCTION public.auto_salience_from_rpe();


--
-- Name: appreciations trg_reinforce_habits_appreciation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reinforce_habits_appreciation AFTER INSERT ON public.appreciations FOR EACH ROW EXECUTE FUNCTION public.reinforce_recent_habits_on_reward();


--
-- Name: gifts_received trg_reinforce_habits_gift; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reinforce_habits_gift AFTER INSERT ON public.gifts_received FOR EACH ROW EXECUTE FUNCTION public.reinforce_recent_habits_on_reward();


--
-- Name: trust_moments trg_reinforce_habits_trust; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_reinforce_habits_trust AFTER INSERT ON public.trust_moments FOR EACH ROW EXECUTE FUNCTION public.reinforce_recent_habits_on_reward();


--
-- Name: skill_usage_log trg_sync_skill_counters; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_skill_counters AFTER INSERT ON public.skill_usage_log FOR EACH ROW EXECUTE FUNCTION public.sync_skill_counters_on_log_insert();


--
-- Name: activation_log activation_log_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activation_log
    ADD CONSTRAINT activation_log_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: adaptive_credit_assignments adaptive_credit_assignments_outcome_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_credit_assignments
    ADD CONSTRAINT adaptive_credit_assignments_outcome_event_id_fkey FOREIGN KEY (outcome_event_id) REFERENCES public.adaptive_outcome_events(id) ON DELETE CASCADE;


--
-- Name: adaptive_credit_assignments adaptive_credit_assignments_reflex_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_credit_assignments
    ADD CONSTRAINT adaptive_credit_assignments_reflex_id_fkey FOREIGN KEY (reflex_id) REFERENCES public.adaptive_reflexes(id) ON DELETE SET NULL;


--
-- Name: adaptive_credit_assignments adaptive_credit_assignments_trace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_credit_assignments
    ADD CONSTRAINT adaptive_credit_assignments_trace_id_fkey FOREIGN KEY (trace_id) REFERENCES public.action_eligibility_traces(id) ON DELETE CASCADE;


--
-- Name: adaptive_outcome_events adaptive_outcome_events_eval_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_outcome_events
    ADD CONSTRAINT adaptive_outcome_events_eval_case_id_fkey FOREIGN KEY (eval_case_id) REFERENCES public.vision_eval_cases(id) ON DELETE SET NULL;


--
-- Name: adaptive_outcome_events adaptive_outcome_events_reflex_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_outcome_events
    ADD CONSTRAINT adaptive_outcome_events_reflex_id_fkey FOREIGN KEY (reflex_id) REFERENCES public.adaptive_reflexes(id) ON DELETE SET NULL;


--
-- Name: adaptive_reflexes adaptive_reflexes_eval_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_reflexes
    ADD CONSTRAINT adaptive_reflexes_eval_case_id_fkey FOREIGN KEY (eval_case_id) REFERENCES public.vision_eval_cases(id) ON DELETE SET NULL;


--
-- Name: adaptive_rpe_reflex_harvests adaptive_rpe_reflex_harvests_reflex_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_rpe_reflex_harvests
    ADD CONSTRAINT adaptive_rpe_reflex_harvests_reflex_id_fkey FOREIGN KEY (reflex_id) REFERENCES public.adaptive_reflexes(id) ON DELETE SET NULL;


--
-- Name: adaptive_rpe_reflex_harvests adaptive_rpe_reflex_harvests_rpe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.adaptive_rpe_reflex_harvests
    ADD CONSTRAINT adaptive_rpe_reflex_harvests_rpe_id_fkey FOREIGN KEY (rpe_id) REFERENCES public.reward_prediction_errors(id) ON DELETE CASCADE;


--
-- Name: alignment_checks alignment_checks_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alignment_checks
    ADD CONSTRAINT alignment_checks_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: antibodies antibodies_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.antibodies
    ADD CONSTRAINT antibodies_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: anticipations anticipations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anticipations
    ADD CONSTRAINT anticipations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: anticipatory_states anticipatory_states_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.anticipatory_states
    ADD CONSTRAINT anticipatory_states_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: appreciations appreciations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appreciations
    ADD CONSTRAINT appreciations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: attention_patterns attention_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attention_patterns
    ADD CONSTRAINT attention_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: blind_spots blind_spots_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blind_spots
    ADD CONSTRAINT blind_spots_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: boundaries_hard boundaries_hard_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boundaries_hard
    ADD CONSTRAINT boundaries_hard_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: boundaries_soft boundaries_soft_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.boundaries_soft
    ADD CONSTRAINT boundaries_soft_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: capacity_limits capacity_limits_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capacity_limits
    ADD CONSTRAINT capacity_limits_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: claims claims_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.claims
    ADD CONSTRAINT claims_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: client_output_violations client_output_violations_client_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: cognitive_biases cognitive_biases_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cognitive_biases
    ADD CONSTRAINT cognitive_biases_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: communication_patterns communication_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communication_patterns
    ADD CONSTRAINT communication_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: constraints_log constraints_log_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.constraints_log
    ADD CONSTRAINT constraints_log_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: content content_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.episodes(id);


--
-- Name: content content_revises_belief_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_revises_belief_fkey FOREIGN KEY (revises_belief) REFERENCES public.content(id);


--
-- Name: content content_self_state_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_self_state_id_fkey FOREIGN KEY (self_state_id) REFERENCES public.self_states(id);


--
-- Name: content content_superseded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content
    ADD CONSTRAINT content_superseded_by_fkey FOREIGN KEY (superseded_by) REFERENCES public.content(id);


--
-- Name: context_switches context_switches_trigger_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.context_switches
    ADD CONSTRAINT context_switches_trigger_event_id_fkey FOREIGN KEY (trigger_event_id) REFERENCES public.salient_events(id);


--
-- Name: contradictions contradictions_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contradictions
    ADD CONSTRAINT contradictions_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id);


--
-- Name: contradictions contradictions_relationship_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contradictions
    ADD CONSTRAINT contradictions_relationship_id_fkey FOREIGN KEY (relationship_id) REFERENCES public.entity_relationships(id);


--
-- Name: core_values core_values_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.core_values
    ADD CONSTRAINT core_values_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: counterfactual_analyses counterfactual_analyses_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterfactual_analyses
    ADD CONSTRAINT counterfactual_analyses_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.episodes(id);


--
-- Name: counterfactual_analyses counterfactual_analyses_prediction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.counterfactual_analyses
    ADD CONSTRAINT counterfactual_analyses_prediction_id_fkey FOREIGN KEY (prediction_id) REFERENCES public.predictions(id);


--
-- Name: curiosity_explorations curiosity_explorations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_explorations
    ADD CONSTRAINT curiosity_explorations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: curiosity_gaps curiosity_gaps_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_gaps
    ADD CONSTRAINT curiosity_gaps_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: curiosity_questions curiosity_questions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.curiosity_questions
    ADD CONSTRAINT curiosity_questions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: decision_reviews decision_reviews_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decision_reviews
    ADD CONSTRAINT decision_reviews_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: desire_cues desire_cues_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desire_cues
    ADD CONSTRAINT desire_cues_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: desire_prediction_errors desire_prediction_errors_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.desire_prediction_errors
    ADD CONSTRAINT desire_prediction_errors_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: drift_patterns drift_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drift_patterns
    ADD CONSTRAINT drift_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: drive_patterns drive_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drive_patterns
    ADD CONSTRAINT drive_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: drives drives_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.drives
    ADD CONSTRAINT drives_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: emergence_log emergence_log_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergence_log
    ADD CONSTRAINT emergence_log_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: emotional_consolidation_events emotional_consolidation_events_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emotional_consolidation_events
    ADD CONSTRAINT emotional_consolidation_events_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: energy_boosts energy_boosts_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_boosts
    ADD CONSTRAINT energy_boosts_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: energy_checkins energy_checkins_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_checkins
    ADD CONSTRAINT energy_checkins_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: energy_drains energy_drains_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.energy_drains
    ADD CONSTRAINT energy_drains_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: engram_members engram_members_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engram_members
    ADD CONSTRAINT engram_members_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: engram_members engram_members_engram_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.engram_members
    ADD CONSTRAINT engram_members_engram_id_fkey FOREIGN KEY (engram_id) REFERENCES public.engrams(id) ON DELETE CASCADE;


--
-- Name: entities entities_first_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entities
    ADD CONSTRAINT entities_first_memory_id_fkey FOREIGN KEY (first_memory_id) REFERENCES public.content(id);


--
-- Name: entity_content_mentions entity_content_mentions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_content_mentions
    ADD CONSTRAINT entity_content_mentions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: entity_content_mentions entity_content_mentions_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_content_mentions
    ADD CONSTRAINT entity_content_mentions_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_properties entity_properties_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_properties
    ADD CONSTRAINT entity_properties_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_from_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_from_entity_id_fkey FOREIGN KEY (from_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: entity_relationships entity_relationships_invalidated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_invalidated_by_fkey FOREIGN KEY (invalidated_by) REFERENCES public.entity_relationships(id);


--
-- Name: entity_relationships entity_relationships_to_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.entity_relationships
    ADD CONSTRAINT entity_relationships_to_entity_id_fkey FOREIGN KEY (to_entity_id) REFERENCES public.entities(id) ON DELETE CASCADE;


--
-- Name: episode_boundaries episode_boundaries_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_boundaries
    ADD CONSTRAINT episode_boundaries_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: episode_boundaries episode_boundaries_previous_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_boundaries
    ADD CONSTRAINT episode_boundaries_previous_content_id_fkey FOREIGN KEY (previous_content_id) REFERENCES public.content(id);


--
-- Name: episode_members episode_members_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_members
    ADD CONSTRAINT episode_members_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: episode_members episode_members_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episode_members
    ADD CONSTRAINT episode_members_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.episodes(id) ON DELETE CASCADE;


--
-- Name: episodes episodes_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.arcs(id);


--
-- Name: episodes episodes_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.episodes
    ADD CONSTRAINT episodes_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: expectations expectations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expectations
    ADD CONSTRAINT expectations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: expressions expressions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.expressions
    ADD CONSTRAINT expressions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: feelings feelings_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feelings
    ADD CONSTRAINT feelings_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: felt_threat_gate_decisions felt_threat_gate_decisions_presence_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_gate_decisions
    ADD CONSTRAINT felt_threat_gate_decisions_presence_event_id_fkey FOREIGN KEY (presence_event_id) REFERENCES public.presence_events(id) ON DELETE SET NULL;


--
-- Name: felt_threat_outcomes felt_threat_outcomes_presence_event_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.felt_threat_outcomes
    ADD CONSTRAINT felt_threat_outcomes_presence_event_id_fkey FOREIGN KEY (presence_event_id) REFERENCES public.presence_events(id) ON DELETE CASCADE;


--
-- Name: focus_events focus_events_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.focus_events
    ADD CONSTRAINT focus_events_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: frustrations frustrations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.frustrations
    ADD CONSTRAINT frustrations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: generative_predictions generative_predictions_actual_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generative_predictions
    ADD CONSTRAINT generative_predictions_actual_observation_id_fkey FOREIGN KEY (actual_observation_id) REFERENCES public.observations(id);


--
-- Name: gifts_received gifts_received_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gifts_received
    ADD CONSTRAINT gifts_received_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: goals goals_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.goals
    ADD CONSTRAINT goals_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: graph_edges graph_edges_evidence_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.graph_edges
    ADD CONSTRAINT graph_edges_evidence_content_id_fkey FOREIGN KEY (evidence_content_id) REFERENCES public.content(id) ON DELETE SET NULL;


--
-- Name: gratitude_moments gratitude_moments_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gratitude_moments
    ADD CONSTRAINT gratitude_moments_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: gratitudes gratitudes_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gratitudes
    ADD CONSTRAINT gratitudes_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: gut_signals gut_signals_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.gut_signals
    ADD CONSTRAINT gut_signals_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: hard_limits hard_limits_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hard_limits
    ADD CONSTRAINT hard_limits_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: inner_observations inner_observations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inner_observations
    ADD CONSTRAINT inner_observations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: inner_pulses inner_pulses_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inner_pulses
    ADD CONSTRAINT inner_pulses_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: insights insights_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.insights
    ADD CONSTRAINT insights_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: intent_sessions intent_sessions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_sessions
    ADD CONSTRAINT intent_sessions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: intent_shifts intent_shifts_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_shifts
    ADD CONSTRAINT intent_shifts_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: intent_shifts intent_shifts_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.intent_shifts
    ADD CONSTRAINT intent_shifts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.intent_sessions(id) ON DELETE CASCADE;


--
-- Name: lc_samples lc_samples_trigger_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lc_samples
    ADD CONSTRAINT lc_samples_trigger_content_id_fkey FOREIGN KEY (trigger_content_id) REFERENCES public.content(id) ON DELETE SET NULL;


--
-- Name: library_entries library_entries_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.library_entries
    ADD CONSTRAINT library_entries_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: loop_cycles loop_cycles_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_cycles
    ADD CONSTRAINT loop_cycles_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: loop_environments loop_environments_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_environments
    ADD CONSTRAINT loop_environments_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: loop_feedback_rules loop_feedback_rules_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_feedback_rules
    ADD CONSTRAINT loop_feedback_rules_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: loop_feedback_rules loop_feedback_rules_env_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_feedback_rules
    ADD CONSTRAINT loop_feedback_rules_env_id_fkey FOREIGN KEY (env_id) REFERENCES public.loop_environments(id);


--
-- Name: loop_invariants loop_invariants_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_invariants
    ADD CONSTRAINT loop_invariants_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: loop_invariants loop_invariants_env_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_invariants
    ADD CONSTRAINT loop_invariants_env_id_fkey FOREIGN KEY (env_id) REFERENCES public.loop_environments(id);


--
-- Name: loop_iterations loop_iterations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_iterations
    ADD CONSTRAINT loop_iterations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: loop_iterations loop_iterations_cycle_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.loop_iterations
    ADD CONSTRAINT loop_iterations_cycle_id_fkey FOREIGN KEY (cycle_id) REFERENCES public.loop_cycles(id);


--
-- Name: memories memories_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: memories memories_subcategory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memories
    ADD CONSTRAINT memories_subcategory_id_fkey FOREIGN KEY (subcategory_id) REFERENCES public.subcategories(id);


--
-- Name: memory_access_log memory_access_log_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_access_log
    ADD CONSTRAINT memory_access_log_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: memory_activation memory_activation_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_activation
    ADD CONSTRAINT memory_activation_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: memory_consolidation memory_consolidation_result_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_consolidation
    ADD CONSTRAINT memory_consolidation_result_content_id_fkey FOREIGN KEY (result_content_id) REFERENCES public.content(id);


--
-- Name: memory_edges memory_edges_from_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_edges
    ADD CONSTRAINT memory_edges_from_content_id_fkey FOREIGN KEY (from_content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: memory_edges memory_edges_to_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_edges
    ADD CONSTRAINT memory_edges_to_content_id_fkey FOREIGN KEY (to_content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: memory_importance memory_importance_memory_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memory_importance
    ADD CONSTRAINT memory_importance_memory_id_fkey FOREIGN KEY (memory_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: meta_anomalies meta_anomalies_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.meta_anomalies
    ADD CONSTRAINT meta_anomalies_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.observations(id);


--
-- Name: milestones milestones_goal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.milestones
    ADD CONSTRAINT milestones_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES public.goals(id) ON DELETE CASCADE;


--
-- Name: mistake_analyses mistake_analyses_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mistake_analyses
    ADD CONSTRAINT mistake_analyses_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: narrative_arcs narrative_arcs_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_arcs
    ADD CONSTRAINT narrative_arcs_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_coherence_checks narrative_coherence_checks_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_coherence_checks
    ADD CONSTRAINT narrative_coherence_checks_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_conflicts narrative_conflicts_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_conflicts
    ADD CONSTRAINT narrative_conflicts_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_consolidation_sessions narrative_consolidation_sessions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_consolidation_sessions
    ADD CONSTRAINT narrative_consolidation_sessions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_episodes narrative_episodes_arc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_episodes
    ADD CONSTRAINT narrative_episodes_arc_id_fkey FOREIGN KEY (arc_id) REFERENCES public.narrative_arcs(id);


--
-- Name: narrative_episodes narrative_episodes_causal_antecedent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_episodes
    ADD CONSTRAINT narrative_episodes_causal_antecedent_id_fkey FOREIGN KEY (causal_antecedent_id) REFERENCES public.narrative_episodes(id);


--
-- Name: narrative_episodes narrative_episodes_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_episodes
    ADD CONSTRAINT narrative_episodes_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_identity_threads narrative_identity_threads_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_identity_threads
    ADD CONSTRAINT narrative_identity_threads_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_life_script narrative_life_script_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_life_script
    ADD CONSTRAINT narrative_life_script_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_life_story narrative_life_story_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_life_story
    ADD CONSTRAINT narrative_life_story_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_life_story narrative_life_story_current_chapter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_life_story
    ADD CONSTRAINT narrative_life_story_current_chapter_id_fkey FOREIGN KEY (current_chapter_id) REFERENCES public.narrative_arcs(id);


--
-- Name: narrative_possible_selves narrative_possible_selves_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_possible_selves
    ADD CONSTRAINT narrative_possible_selves_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_primed narrative_primed_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_primed
    ADD CONSTRAINT narrative_primed_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_schemas narrative_schemas_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_schemas
    ADD CONSTRAINT narrative_schemas_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_segments narrative_segments_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_segments
    ADD CONSTRAINT narrative_segments_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_self_defining_memories narrative_self_defining_memories_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_self_defining_memories
    ADD CONSTRAINT narrative_self_defining_memories_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: narrative_self_defining_memories narrative_self_defining_memories_episode_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_self_defining_memories
    ADD CONSTRAINT narrative_self_defining_memories_episode_id_fkey FOREIGN KEY (episode_id) REFERENCES public.narrative_episodes(id);


--
-- Name: narrative_self_defining_memories narrative_self_defining_memories_memory_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_self_defining_memories
    ADD CONSTRAINT narrative_self_defining_memories_memory_source_id_fkey FOREIGN KEY (memory_source_id) REFERENCES public.content(id);


--
-- Name: narrative_threads narrative_threads_competing_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_threads
    ADD CONSTRAINT narrative_threads_competing_thread_id_fkey FOREIGN KEY (competing_thread_id) REFERENCES public.narrative_threads(id);


--
-- Name: narrative_threads narrative_threads_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.narrative_threads
    ADD CONSTRAINT narrative_threads_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: needs_forecast needs_forecast_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.needs_forecast
    ADD CONSTRAINT needs_forecast_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: neuroception_signals neuroception_signals_scan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_signals
    ADD CONSTRAINT neuroception_signals_scan_id_fkey FOREIGN KEY (scan_id) REFERENCES public.neuroception_scans(id);


--
-- Name: neuroception_states neuroception_states_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.neuroception_states
    ADD CONSTRAINT neuroception_states_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: patterns_observed patterns_observed_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patterns_observed
    ADD CONSTRAINT patterns_observed_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: phrases_that_work phrases_that_work_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phrases_that_work
    ADD CONSTRAINT phrases_that_work_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: phrases_to_avoid phrases_to_avoid_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phrases_to_avoid
    ADD CONSTRAINT phrases_to_avoid_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: prediction_chains prediction_chains_prediction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prediction_chains
    ADD CONSTRAINT prediction_chains_prediction_id_fkey FOREIGN KEY (prediction_id) REFERENCES public.generative_predictions(id);


--
-- Name: prediction_errors prediction_errors_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prediction_errors
    ADD CONSTRAINT prediction_errors_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: predictions predictions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: predictions predictions_parent_prediction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.predictions
    ADD CONSTRAINT predictions_parent_prediction_id_fkey FOREIGN KEY (parent_prediction_id) REFERENCES public.predictions(id);


--
-- Name: preferences preferences_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.preferences
    ADD CONSTRAINT preferences_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: priority_alerts priority_alerts_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_alerts
    ADD CONSTRAINT priority_alerts_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: priority_alerts priority_alerts_system_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_alerts
    ADD CONSTRAINT priority_alerts_system_name_fkey FOREIGN KEY (system_name) REFERENCES public.priority_systems(name);


--
-- Name: priority_alerts priority_alerts_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_alerts
    ADD CONSTRAINT priority_alerts_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES public.priority_tiers(id);


--
-- Name: priority_state_modifiers priority_state_modifiers_state_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_state_modifiers
    ADD CONSTRAINT priority_state_modifiers_state_id_fkey FOREIGN KEY (state_id) REFERENCES public.priority_states(id) ON DELETE CASCADE;


--
-- Name: priority_state_modifiers priority_state_modifiers_system_name_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_state_modifiers
    ADD CONSTRAINT priority_state_modifiers_system_name_fkey FOREIGN KEY (system_name) REFERENCES public.priority_systems(name) ON DELETE CASCADE;


--
-- Name: priority_systems priority_systems_tier_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.priority_systems
    ADD CONSTRAINT priority_systems_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES public.priority_tiers(id);


--
-- Name: purpose_statements purpose_statements_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.purpose_statements
    ADD CONSTRAINT purpose_statements_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: pushback_log pushback_log_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pushback_log
    ADD CONSTRAINT pushback_log_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: recovery_patterns recovery_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_patterns
    ADD CONSTRAINT recovery_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: recurring_events recurring_events_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recurring_events
    ADD CONSTRAINT recurring_events_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: research_claims research_claims_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_claims
    ADD CONSTRAINT research_claims_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.research_threads(id) ON DELETE CASCADE;


--
-- Name: research_log research_log_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_log
    ADD CONSTRAINT research_log_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.research_threads(id) ON DELETE CASCADE;


--
-- Name: responsibility_map responsibility_map_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibility_map
    ADD CONSTRAINT responsibility_map_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: reward_prediction_errors reward_prediction_errors_context_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reward_prediction_errors
    ADD CONSTRAINT reward_prediction_errors_context_content_id_fkey FOREIGN KEY (context_content_id) REFERENCES public.content(id) ON DELETE SET NULL;


--
-- Name: rewards_log rewards_log_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rewards_log
    ADD CONSTRAINT rewards_log_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: rhythm_samples rhythm_samples_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rhythm_samples
    ADD CONSTRAINT rhythm_samples_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: salience_events salience_events_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_events
    ADD CONSTRAINT salience_events_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: salience_filters salience_filters_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salience_filters
    ADD CONSTRAINT salience_filters_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: salient_events salient_events_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.salient_events
    ADD CONSTRAINT salient_events_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: satisfactions satisfactions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.satisfactions
    ADD CONSTRAINT satisfactions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: satisfactions satisfactions_want_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.satisfactions
    ADD CONSTRAINT satisfactions_want_id_fkey FOREIGN KEY (want_id) REFERENCES public.wants(id) ON DELETE CASCADE;


--
-- Name: schema_deviations schema_deviations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_deviations
    ADD CONSTRAINT schema_deviations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: schema_deviations schema_deviations_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_deviations
    ADD CONSTRAINT schema_deviations_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.experience_schemas(id) ON DELETE CASCADE;


--
-- Name: schema_instances schema_instances_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_instances
    ADD CONSTRAINT schema_instances_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: schema_instances schema_instances_schema_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_instances
    ADD CONSTRAINT schema_instances_schema_id_fkey FOREIGN KEY (schema_id) REFERENCES public.experience_schemas(id) ON DELETE CASCADE;


--
-- Name: seeking_episodes seeking_episodes_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seeking_episodes
    ADD CONSTRAINT seeking_episodes_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: seeking_episodes seeking_episodes_want_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.seeking_episodes
    ADD CONSTRAINT seeking_episodes_want_id_fkey FOREIGN KEY (want_id) REFERENCES public.wants(id);


--
-- Name: session_times session_times_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_times
    ADD CONSTRAINT session_times_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: shared_history shared_history_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.shared_history
    ADD CONSTRAINT shared_history_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: skill_triggers skill_triggers_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_triggers
    ADD CONSTRAINT skill_triggers_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: skill_usage_log skill_usage_log_skill_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.skill_usage_log
    ADD CONSTRAINT skill_usage_log_skill_id_fkey FOREIGN KEY (skill_id) REFERENCES public.content(id);


--
-- Name: slack_freedoms slack_freedoms_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_freedoms
    ADD CONSTRAINT slack_freedoms_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: slack_readings slack_readings_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_readings
    ADD CONSTRAINT slack_readings_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: slack_tasks slack_tasks_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.slack_tasks
    ADD CONSTRAINT slack_tasks_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: soft_limits soft_limits_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.soft_limits
    ADD CONSTRAINT soft_limits_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: somatic_markers somatic_markers_decision_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.somatic_markers
    ADD CONSTRAINT somatic_markers_decision_content_id_fkey FOREIGN KEY (decision_content_id) REFERENCES public.content(id);


--
-- Name: spiral_log spiral_log_proposal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--



--
-- Name: state_deltas state_deltas_from_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_deltas
    ADD CONSTRAINT state_deltas_from_snapshot_id_fkey FOREIGN KEY (from_snapshot_id) REFERENCES public.state_snapshots(id);


--
-- Name: state_deltas state_deltas_to_snapshot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.state_deltas
    ADD CONSTRAINT state_deltas_to_snapshot_id_fkey FOREIGN KEY (to_snapshot_id) REFERENCES public.state_snapshots(id);


--
-- Name: subcategories subcategories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subcategories
    ADD CONSTRAINT subcategories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id);


--
-- Name: synaptic_pruning_candidates synaptic_pruning_candidates_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.synaptic_pruning_candidates
    ADD CONSTRAINT synaptic_pruning_candidates_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: thinking_patterns thinking_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.thinking_patterns
    ADD CONSTRAINT thinking_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: threads threads_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: threads threads_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_merged_into_fkey FOREIGN KEY (merged_into) REFERENCES public.threads(id);


--
-- Name: time_patterns time_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_patterns
    ADD CONSTRAINT time_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: time_preferences time_preferences_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.time_preferences
    ADD CONSTRAINT time_preferences_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: token_spends token_spends_token_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_spends
    ADD CONSTRAINT token_spends_token_id_fkey FOREIGN KEY (token_id) REFERENCES public.tokens(id) ON DELETE RESTRICT;


--
-- Name: tokens tokens_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tokens
    ADD CONSTRAINT tokens_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.token_verifiers(id);


--
-- Name: tone_experiments tone_experiments_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tone_experiments
    ADD CONSTRAINT tone_experiments_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id);


--
-- Name: tool_invocations tool_invocations_parent_invocation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tool_invocations
    ADD CONSTRAINT tool_invocations_parent_invocation_id_fkey FOREIGN KEY (parent_invocation_id) REFERENCES public.tool_invocations(id) ON DELETE SET NULL;


--
-- Name: trust_moments trust_moments_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trust_moments
    ADD CONSTRAINT trust_moments_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: urges urges_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.urges
    ADD CONSTRAINT urges_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: verification_observables verification_observables_claim_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.verification_observables
    ADD CONSTRAINT verification_observables_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES public.done_claims(id);


--
-- Name: vision_capability_dependencies vision_capability_dependencies_capability_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_dependencies
    ADD CONSTRAINT vision_capability_dependencies_capability_id_fkey FOREIGN KEY (capability_id) REFERENCES public.vision_capabilities(id) ON DELETE CASCADE;


--
-- Name: vision_capability_probe_runs vision_capability_probe_runs_probe_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_probe_runs
    ADD CONSTRAINT vision_capability_probe_runs_probe_id_fkey FOREIGN KEY (probe_id) REFERENCES public.vision_capability_probes(id) ON DELETE CASCADE;


--
-- Name: vision_capability_probes vision_capability_probes_capability_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_capability_probes
    ADD CONSTRAINT vision_capability_probes_capability_id_fkey FOREIGN KEY (capability_id) REFERENCES public.vision_capabilities(id) ON DELETE CASCADE;


--
-- Name: vision_eval_results vision_eval_results_case_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_results
    ADD CONSTRAINT vision_eval_results_case_id_fkey FOREIGN KEY (case_id) REFERENCES public.vision_eval_cases(id) ON DELETE CASCADE;


--
-- Name: vision_eval_results vision_eval_results_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.vision_eval_results
    ADD CONSTRAINT vision_eval_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.vision_eval_runs(id) ON DELETE CASCADE;


--
-- Name: wander_attractions wander_attractions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_attractions
    ADD CONSTRAINT wander_attractions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: wander_attractions wander_attractions_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_attractions
    ADD CONSTRAINT wander_attractions_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.wander_sessions(id) ON DELETE CASCADE;


--
-- Name: wander_choice_points wander_choice_points_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_choice_points
    ADD CONSTRAINT wander_choice_points_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: wander_choice_points wander_choice_points_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_choice_points
    ADD CONSTRAINT wander_choice_points_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.wander_sessions(id) ON DELETE CASCADE;


--
-- Name: wander_emergent_patterns wander_emergent_patterns_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_emergent_patterns
    ADD CONSTRAINT wander_emergent_patterns_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: wander_sessions wander_sessions_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_sessions
    ADD CONSTRAINT wander_sessions_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: wander_side_quests wander_side_quests_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_side_quests
    ADD CONSTRAINT wander_side_quests_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: wander_side_quests wander_side_quests_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wander_side_quests
    ADD CONSTRAINT wander_side_quests_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.wander_sessions(id) ON DELETE CASCADE;


--
-- Name: wants wants_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.wants
    ADD CONSTRAINT wants_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: working_memory_binding_members working_memory_binding_members_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory_binding_members
    ADD CONSTRAINT working_memory_binding_members_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.working_memory_bindings(id) ON DELETE CASCADE;


--
-- Name: working_memory_binding_members working_memory_binding_members_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory_binding_members
    ADD CONSTRAINT working_memory_binding_members_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: working_memory working_memory_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.working_memory
    ADD CONSTRAINT working_memory_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: workspace_broadcasts workspace_broadcasts_coalition_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_broadcasts
    ADD CONSTRAINT workspace_broadcasts_coalition_id_fkey FOREIGN KEY (coalition_id) REFERENCES public.workspace_coalitions(id);


--
-- Name: world_entities world_entities_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_entities
    ADD CONSTRAINT world_entities_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: world_observations world_observations_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_observations
    ADD CONSTRAINT world_observations_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: world_properties world_properties_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_properties
    ADD CONSTRAINT world_properties_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: world_properties world_properties_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_properties
    ADD CONSTRAINT world_properties_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.world_entities(id) ON DELETE CASCADE;


--
-- Name: world_relationships world_relationships_content_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_relationships
    ADD CONSTRAINT world_relationships_content_id_fkey FOREIGN KEY (content_id) REFERENCES public.content(id) ON DELETE CASCADE;


--
-- Name: world_relationships world_relationships_from_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_relationships
    ADD CONSTRAINT world_relationships_from_entity_fkey FOREIGN KEY (from_entity) REFERENCES public.world_entities(id) ON DELETE CASCADE;


--
-- Name: world_relationships world_relationships_to_entity_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.world_relationships
    ADD CONSTRAINT world_relationships_to_entity_fkey FOREIGN KEY (to_entity) REFERENCES public.world_entities(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

