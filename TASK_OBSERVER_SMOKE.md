Spawn one native task subagent and one async bash job. Keep both alive long enough for observer auto-open to be visible.

Requirements:
- Start exactly one native task subagent. It should wait 20 seconds, then print TASK_DONE.
- Start exactly one async bash job. It should wait 20 seconds, then print BASH_DONE.
- Do not edit files.
- Do not continue to unrelated work.
- If observer does not auto-open when they start, report OBSERVER_AUTO_OPEN_FAILED and stop.
- If observer auto-opens, report OBSERVER_AUTO_OPEN_OK after both complete.

Expected user-visible behavior:
- Observer opens by itself shortly after task/job start.
- Observer shows one native task card and one async bash job card.
- Cards transition to completed after the 20 second waits finish.
