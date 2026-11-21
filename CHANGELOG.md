# Changelog

## [0.3.2](https://github.com/Soleone/factory/compare/v0.3.1...v0.3.2) (2026-11-21)

### Bug Fixes

* **goals:** approve a goal from its status, not before its plan exists ([5b8b162](https://github.com/Soleone/factory/commit/5b8b162506b7376ab459ef51ca56a0d249e40401))
* **goals:** keep the goal memory through reviews, and a clearer goal page ([b3ca3e5](https://github.com/Soleone/factory/commit/b3ca3e5b6f72cac62dd055fc35b525fc13a64b30))

## [0.3.1](https://github.com/Soleone/factory/compare/v0.3.0...v0.3.1) (2026-11-21)

### Features

* **goals:** start a goal from the page, in a repo or a new project ([8c48092](https://github.com/Soleone/factory/commit/8c4809268a58d887a047697d5457d9f7a8264500))

## [0.3.0](https://github.com/Soleone/factory/compare/v0.2.2...v0.3.0) (2026-11-21)

### Features

* **activity:** open the task's details in place instead of filtering Results to it ([a020034](https://github.com/Soleone/factory/commit/a020034ef84a447a3121f857d91b175d8091bb1c))
* goals as graphs of jobs, sessions with follow-ups, tiers and pools ([1b642c7](https://github.com/Soleone/factory/commit/1b642c7401d29d7525c000cea0fb732af4204783))
* mirror goals into Tasks, both ways ([cf75deb](https://github.com/Soleone/factory/commit/cf75deb948a871609fd10a4150bf9add4e27c076))
* **page:** a Goals tab with each goal's graph, workers by pool, and tiers ([4ec9113](https://github.com/Soleone/factory/commit/4ec91134e42f26fde6661365258854b00e46e736))
* **results:** GitHub-style header, batch actions replace the filter while selecting ([2c43b9f](https://github.com/Soleone/factory/commit/2c43b9fcfe8da1df1aecfc630110b70e9ea16f4a))
* **results:** pick the filter from a dropdown instead of buttons ([692721f](https://github.com/Soleone/factory/commit/692721f62ed6a5c54232b769156702744e21865b))
* **ui:** tooltips on the dismiss, remove and queue-with icon buttons ([3051a15](https://github.com/Soleone/factory/commit/3051a1514cece74bfb23e29ccff621f6d1757417))

### Bug Fixes

* **goals:** a milestone's nodes wait for what the milestone comes after ([ab4cca9](https://github.com/Soleone/factory/commit/ab4cca923a91c150b5c9a55fbad46db38e0222a1))
* **page:** setQueryParam is only used inside its hook ([5e68660](https://github.com/Soleone/factory/commit/5e68660ad1ce7bacb47b7151283a3c5fe527055d))
* **tasks:** show a finished job's prompt from its run, not workwork's candidate list ([c3e27ad](https://github.com/Soleone/factory/commit/c3e27ada286d1825b7b2328465fce80e83b59ff5))

## [0.2.2](https://github.com/Soleone/factory/compare/v0.2.1...v0.2.2) (2026-11-19)

### Features

* **candidates:** add local repo filters and clone action ([0261062](https://github.com/Soleone/factory/commit/0261062517354eae51c294cb07f563edf9b5e8ea))
* one row layout everywhere, theme colors, quieter buttons ([c4f9b9d](https://github.com/Soleone/factory/commit/c4f9b9d9b9521c6501f307cd719942a6bb21452a))
* unify task details across candidates, queue, and results ([f5337bb](https://github.com/Soleone/factory/commit/f5337bbb2bd53eb50532907ddfe0026b63cef166))

## [0.2.1](https://github.com/Soleone/factory/compare/v0.2.0...v0.2.1) (2026-11-19)

### Features

* agents report back, jobs wait on each other, activity feed ([c0ac56b](https://github.com/Soleone/factory/commit/c0ac56b6fc321ed58ed071e51de065f5454de403))
* **clone:** clone repositories directly into the source root ([7747d4a](https://github.com/Soleone/factory/commit/7747d4aac82d612beb5f1f79892e81c59b951045))
* drop jobs waiting on failed ones, record merge train results ([5e2b9a7](https://github.com/Soleone/factory/commit/5e2b9a762210d6ce74041b07c0ac288014d3d493))

### Bug Fixes

* **model-picker:** preserve search text during refresh ([c6ef7b8](https://github.com/Soleone/factory/commit/c6ef7b8becdb4c8827fb72fa3efe00fce9875663))

## [0.2.0](https://github.com/Soleone/factory/compare/v0.1.0...v0.2.0) (2026-11-19)

### ⚠ BREAKING CHANGES

* the old ledger format is replaced by jobs.jsonl, and
  --claude-model, --pi-model and --windows are replaced by per-agent
  --model/--effort and --limit.

### Features

* add dialog to clone GitHub repos into $SRC ([dbb6610](https://github.com/Soleone/factory/commit/dbb6610fb3930d8c37d3d31a671c64dacbf7f04d))
* always-on factory with queue, runs and web UI ([47f7a3a](https://github.com/Soleone/factory/commit/47f7a3adbc01b2e7111c17d5cd516fc4b595c690))
* animate header logo and make power a switch ([5a7f5fb](https://github.com/Soleone/factory/commit/5a7f5fbac076734d38bdc1ea49ab294f2069761f))
* **badge:** add accent variant for on state ([5affa67](https://github.com/Soleone/factory/commit/5affa672dec51f411c3e283385a7ca7c7f5b83fd))
* **browse:** add repo filter to browse view ([ff138ce](https://github.com/Soleone/factory/commit/ff138cec9b0889d51fdda9d4824116a07f170f33))
* **demo:** add isolated UI demo mode ([7b69ffc](https://github.com/Soleone/factory/commit/7b69ffc37956e4c3a6a7ab6a5db8f5cad6e2ac7f))
* **plan:** chat with Pi to plan the queue ([636f0e8](https://github.com/Soleone/factory/commit/636f0e865e5cb7cdc628a8ec58ed19489efcdc4f))
* **plan:** keep the chat across restarts of serve ([f9e1354](https://github.com/Soleone/factory/commit/f9e1354a896b2075fba45113a421645da3860f33))
* **plan:** pick the chat agent, model and effort; Claude Code joins Pi ([a05c80f](https://github.com/Soleone/factory/commit/a05c80faf643bb67e0b2206135e3f4ad5ff67b55))
* **plan:** show questions from Pi's extensions and send back the answer ([8b307b7](https://github.com/Soleone/factory/commit/8b307b7083600582e8203faa4b89172448c8c348))
* queue candidates for a chosen agent or preset ([86fd3b6](https://github.com/Soleone/factory/commit/86fd3b675824c42a4332a34f3af585857bc19d3b))
* **queue:** animate queue rows on reorder and removal ([1832f2a](https://github.com/Soleone/factory/commit/1832f2a0535c706548f115327675732aac0798f7))
* refresh favicon and add it to the app heading ([66b4a8d](https://github.com/Soleone/factory/commit/66b4a8de1b7db1bf9be1fd6efae27123838ebbe2))
* **results:** add batch dismissal for completed jobs ([1e1ae04](https://github.com/Soleone/factory/commit/1e1ae04e72864d67edbf9b2b0aadc4ad9b10f4d4))
* **results:** ask Pi about a failed job or a PR the train skipped ([e4449a9](https://github.com/Soleone/factory/commit/e4449a9a05fe8608ef0f3cfa51be5542fb238fea))
* **results:** merge selected PRs one after another ([6409082](https://github.com/Soleone/factory/commit/64090820a18869ec4bf3933a9bbbd567d3872a75))
* **results:** review and merge agent PRs from the page ([4d548d1](https://github.com/Soleone/factory/commit/4d548d1634fbbcf294d93034220f061c994a2772))
* **review:** rebase conflicted PRs and inspect attempt logs ([942885f](https://github.com/Soleone/factory/commit/942885fbc1c904278075c3d032dccc76bab270e5))
* **review:** show PR description and diff in a review dialog ([00ba223](https://github.com/Soleone/factory/commit/00ba223e642c586b873295e7067eb24b2d57076c))
* **run:** turning off hands agents to the next run instead of killing them ([982abfb](https://github.com/Soleone/factory/commit/982abfb52e9cdd617f8af68f447d5c7478523c69))
* **serve:** add web page for status, queue and results ([b70476d](https://github.com/Soleone/factory/commit/b70476d0a13104a58a846c8ff956182ec188b664))
* **settings:** move settings into a header dialog ([fa70642](https://github.com/Soleone/factory/commit/fa706422e6d5968d8a550f42f6763a03ca769b14))
* **settings:** offer each model's own effort levels ([bec96ff](https://github.com/Soleone/factory/commit/bec96ff2ca013b543b763fb8fadff68575f0bd6e))
* **soleone:** show tooltips instead of native title attributes ([6521daf](https://github.com/Soleone/factory/commit/6521daffa432fe8f6b050c0ae22db7eeec754b4b))
* stage, preview and approve candidates from picked repos, and run only the approved queue ([ee4df78](https://github.com/Soleone/factory/commit/ee4df78d8fa77143d0776e8619a1bb4244506bf7))
* **train:** queue an agent job to resolve conflicts the train can't rebase ([6a35dc4](https://github.com/Soleone/factory/commit/6a35dc42962e355bb9186bcf9b4888c95eb5c93e))
* **ui:** move Plan chat behind a Live Agent button ([1cd21e5](https://github.com/Soleone/factory/commit/1cd21e54e7aec2ab2a7317ac6ff1abaa4e8fea0f))
* **ui:** pop the logo windows while working ([7977c52](https://github.com/Soleone/factory/commit/7977c52e53a52e676eb3461e12258b3731357f8d))
* **ui:** show candidate tasks and play descriptions ([b5221d8](https://github.com/Soleone/factory/commit/b5221d84d7d651d86052645073ef5991a5e794a3))

### Bug Fixes

* isolate agent worktrees by repository path ([046ad6e](https://github.com/Soleone/factory/commit/046ad6e8a5bb26edf0c43052fa6aab1d75708532))
* setup failures stop churning, show their log, and auto mode can pick repos ([6dd1653](https://github.com/Soleone/factory/commit/6dd1653dfee4ccf52048773667e95115c60e14ae))
* stop at first usage limit by default ([91d7235](https://github.com/Soleone/factory/commit/91d7235215f74c733f6b475f79b0f8121d8aa887))

## 0.1.0 (2026-11-16)

### Features

* factory runs workwork candidates through headless agents until the limits run out ([ea719a9](https://github.com/Soleone/factory/commit/ea719a984a995a1fd3f81ea5946154317b5c1f12))
