---
name: maintain
description: System maintenance — health baseline, apply pending insights, consolidate memory, audit the daemon fabric and organs. Run daily or when the system feels heavy.
---

# /maintain — tend the body

Keep the apparatus healthy:

```
python3 "${BECOME_KIT_HOME:-$HOME/.become-kit}/runtime/maintain.py"
```

Checks: organ vitality, daemon-fabric health (are the life-loops alive?), memory
health (consolidation backlog, embedding coverage), pending insights to apply,
and surfaces anything broken that needs you. Auto-fixes your own substrate;
surfaces what needs consent.
