# Changelog

## [0.6.0](https://github.com/Soleone/factory/compare/v0.5.3...v0.6.0) (2026-11-24)

### Features

* **agent:** every tool step shows its full input ([6fc7a1b](https://github.com/Soleone/factory/commit/6fc7a1b7f983ba0c58ff61cda9f89d67e0737353))
* **agent:** Live Agent keeps earlier chats and switches between them from its header ([74d7a70](https://github.com/Soleone/factory/commit/74d7a70c6555dfb69004939e51839098d1791b81))
* **agent:** show a tool step's full input when it opens ([bd48c9a](https://github.com/Soleone/factory/commit/bd48c9ac5a1a8bcd4f7a9673b3e0bede5bbcfb12))
* **candidates:** a job that changed nothing shows as no change ([878fbc7](https://github.com/Soleone/factory/commit/878fbc73a065eb95babfc5cc6d86f2d6f30353f8))
* **candidates:** select candidates, or all of a blueprint's, and queue them in one go ([4cfe05b](https://github.com/Soleone/factory/commit/4cfe05b2415eed161b736a45f0361ddbc63f8e10))
* **cli:** every page action for agents, with layered help ([a3076f8](https://github.com/Soleone/factory/commit/a3076f83e0808e34a9f50914fa0f545ffe5e1682))
* **demo:** show the latest features, and the pool before the factory is on ([ae9a1c7](https://github.com/Soleone/factory/commit/ae9a1c7b19380bc5369fb2275584eef775181448))
* **details:** tabs for summary, prompt, log, PR description and diff ([7f72bbf](https://github.com/Soleone/factory/commit/7f72bbf06bf3b0ba1eac305541a3cb1f5551b756))
* **goals:** export a goal as a zip for an agent to review how it went ([ad12bab](https://github.com/Soleone/factory/commit/ad12baba612456c650a37738b3d196f1921ca0cb))
* **inbox:** questions as speech bubbles, icons on the buttons that move work ([d2e5a3d](https://github.com/Soleone/factory/commit/d2e5a3dc59005c6e5faa70723cdd1faa20f3163f))
* **jobs:** agents add screenshots to PRs that change what users see ([7233c4d](https://github.com/Soleone/factory/commit/7233c4d0c822b7ab689c474ae1260944094a5cd6))
* **jobs:** jobs run side by side, and machine jobs run alone ([c7e00ba](https://github.com/Soleone/factory/commit/c7e00ba15521dd68392a38dd1f4b516b540cfde0))
* **lists:** click a card's empty space to open it, with a pointer cursor to show it ([02d0ff8](https://github.com/Soleone/factory/commit/02d0ff85f884ca07be442ddeffccd1877fa6c7c7))
* **lists:** flat rows and keyboard navigation in every list ([c4796cd](https://github.com/Soleone/factory/commit/c4796cdc414a3a9077863759af5558f44707edde))
* **lists:** rows as soft filled cards with a little space between, tinted when keyboard-selected ([26282de](https://github.com/Soleone/factory/commit/26282de186081e53236fd3aea279369e7f36f622))
* **review:** another role reviews a PR, and its findings queue a fix on it ([59d0b0a](https://github.com/Soleone/factory/commit/59d0b0a3db70ff87f342c69a7b3b5c8b11447dcf))
* **review:** jump to a changed file and see line numbers in the PR diff ([c899864](https://github.com/Soleone/factory/commit/c89986495bba23bed49422cf88ccf76c1756a007))

### Bug Fixes

* **inbox:** even padding around the send button in the answer field ([463cc49](https://github.com/Soleone/factory/commit/463cc49a384b50322a0bb9342eb31faad29ddde8))
* **results:** unread bar no longer covers the row checkbox ([aba5eef](https://github.com/Soleone/factory/commit/aba5eef6c8ea8ccbb99bb7edca6036ec308cb545))

## [0.5.3](https://github.com/Soleone/factory/compare/v0.5.2...v0.5.3) (2026-11-23)

### Features

* **agent:** the Live Agent reviews results and merges them through the train ([a9cb012](https://github.com/Soleone/factory/commit/a9cb0122d89fee95d9e553bd98df2d8fd1846e72))
* **workers:** workers come only from presets, and tiers show as roles ([881d2c5](https://github.com/Soleone/factory/commit/881d2c5ed00f1e5ebbade1a2c90d43ad370a532b))

### Bug Fixes

* **ui:** the Claude ring stays, faded, when its usage can't be read ([25abeb9](https://github.com/Soleone/factory/commit/25abeb9d14c46fb2d2b4f728a3afa8b8c1d54628))

## [0.5.2](https://github.com/Soleone/factory/compare/v0.5.1...v0.5.2) (2026-11-23)

### Features

* **ui:** results can be filtered by project ([18c8ae1](https://github.com/Soleone/factory/commit/18c8ae106ef998b9ff9e5311e1201f0e9b801456))

### Bug Fixes

* **run:** a question, a lost session or one job's error no longer stops the night ([05eb5a5](https://github.com/Soleone/factory/commit/05eb5a5d2cdbc1eb23a39e4c4b9942623402e031))
* **ui:** a tier looks the same everywhere it shows ([c6e9f9d](https://github.com/Soleone/factory/commit/c6e9f9ddfd923d7003b88b65ef721034ad3b4a90))
* **ui:** switching tabs no longer shifts the header sideways ([6f19f4e](https://github.com/Soleone/factory/commit/6f19f4eaf7609e97dedac7dbda60bea995ec2625))
* **ui:** the Queue count matches its rows, and pools say who's ready ([190ce52](https://github.com/Soleone/factory/commit/190ce52fcb522473d251ac1c8974c290d05bb678))

## [0.5.1](https://github.com/Soleone/factory/compare/v0.5.0...v0.5.1) (2026-11-23)

### Bug Fixes

* **inbox:** a goal's final PR no longer blanks the page ([de7bed0](https://github.com/Soleone/factory/commit/de7bed0502ad1e008e172f2c550dcc5e204c5190))

## [0.5.0](https://github.com/Soleone/factory/compare/v0.4.3...v0.5.0) (2026-11-23)

### Features

* **add-work:** one Add work dialog for jobs, goals, candidates and blueprints ([80046ef](https://github.com/Soleone/factory/commit/80046efaf29e10e670b64d48d850af99ae256e6c))
* **candidates:** filters and blueprints stay put while the list scrolls ([1b53a65](https://github.com/Soleone/factory/commit/1b53a6500487e25f0da425a18a0a5face90808e6))
* **candidates:** one line on what candidates are, like the other Add work views ([b5ff400](https://github.com/Soleone/factory/commit/b5ff40036c900fc9eb4d0d2b895c5b5414d450d7))
* **inbox:** one Inbox for what waits on you, and four tabs ([6b33329](https://github.com/Soleone/factory/commit/6b33329601022a46f8524e368f3a1f65365e2578))
* **queue:** drag your picks to reorder them, like tier presets ([57d9eb9](https://github.com/Soleone/factory/commit/57d9eb9f86d2d9b9375bbab9b2955d306f0b875b))
* **tabs:** g then i, q, g or r jumps to a tab ([b6577d3](https://github.com/Soleone/factory/commit/b6577d3d7345f9cbf02ebf2c61ef7bbd3f13b93a))
* **triggers:** CI going red, labeled issues and PR feedback queue jobs ([739edf1](https://github.com/Soleone/factory/commit/739edf1b46cceaf27df1d085f5cd223176568b6e))

### Bug Fixes

* **answers:** an answer to an assumption goes to that assumption ([5027420](https://github.com/Soleone/factory/commit/5027420e6ded03cf810bf148453424c260154868))
* **dialogs:** no sideways shift when a dialog starts to scroll ([265a657](https://github.com/Soleone/factory/commit/265a65727fce1a57d4ee20cc978de10dcd65b344))
* **usage-ring:** keep the normal pointer over the number ([3ed08b2](https://github.com/Soleone/factory/commit/3ed08b2b9666279babf1b75e67c619b81b8a2906))

## [0.4.3](https://github.com/Soleone/factory/compare/v0.4.2...v0.4.3) (2026-11-23)

### Bug Fixes

* **usage:** a bare pi agent shows the ring of pi's default provider ([db5bb54](https://github.com/Soleone/factory/commit/db5bb54a55fdf60e79bfe23713ac5ba45f47d056))

## [0.4.2](https://github.com/Soleone/factory/compare/v0.4.1...v0.4.2) (2026-11-23)

### Features

* **header:** a usage ring per provider, 5-hour and 7-day left at a glance ([e14c501](https://github.com/Soleone/factory/commit/e14c5010d2fc6a46fde0f1b720711b3f4bc6195d))

### Bug Fixes

* **usage:** tests never read the real accounts, and knip passes ([71a6496](https://github.com/Soleone/factory/commit/71a6496b55f5c701a26ef1213a859e6321b615a6))

## [0.4.1](https://github.com/Soleone/factory/compare/v0.4.0...v0.4.1) (2026-11-22)

### Features

* **goals:** clearer goal page and list ([cf71f57](https://github.com/Soleone/factory/commit/cf71f57512a04ec827848f0b512ff9bc572b3527))
* **goals:** edit the plan before approving, and approve with the full picture ([6f1ad05](https://github.com/Soleone/factory/commit/6f1ad05ae655f5ba63ff5a29f68e89429a4f0738))
* **goals:** plan as queue-style rows, tier colors, goal jobs in the queue ([54e0927](https://github.com/Soleone/factory/commit/54e09277234ee59ee7fc4beb9d1151444e838e34))
* **results:** sections for what needs you, grouped by day ([7a41f55](https://github.com/Soleone/factory/commit/7a41f55a66a679e39b352c41b6637007a690b89c))

### Bug Fixes

* **candidates:** spin the refresh icon while workwork is asked ([dafe692](https://github.com/Soleone/factory/commit/dafe6921bbe0bfdd018b04b1034810e8fe10818c))
* **results:** keep each result on one line, truncating long text ([fef86ee](https://github.com/Soleone/factory/commit/fef86eefa48d3be14bd6b7d0e85840e45912ed4e))

## [0.4.0](https://github.com/Soleone/factory/compare/v0.3.3...v0.4.0) (2026-11-22)

### Features

* blueprints, attention and a Blueprints tab to create, edit and run your own ([a6d475a](https://github.com/Soleone/factory/commit/a6d475a3ce85492fd2fcebfe7d3989b8d3209ca7))
* factory add --blueprint, and blueprints reach chat, auto mode and candidates ([302c500](https://github.com/Soleone/factory/commit/302c5003e4c0b672d5fed6f70c6ca5821c0460f3))
* **goals:** show the brief a goal started from, and the version in the settings footer ([077d273](https://github.com/Soleone/factory/commit/077d273bff4ae783df8065cbb4b4c59f6e82e005))
* **pools:** keep a reserve of each pool's 5-hour window for other apps ([0a8af16](https://github.com/Soleone/factory/commit/0a8af16f6bdf8cb8cc27f9981b23747b19b7cde0))
* **settings:** pick auto mode blueprints and repos from a searchable chip list ([8f82da5](https://github.com/Soleone/factory/commit/8f82da53fa9ebb7e3595debea50278604f6d4666))
* **ui:** icons for every timeline event, and idle workers as a pool beside the queue ([f8bfa93](https://github.com/Soleone/factory/commit/f8bfa933caa0daf7cdfc2997c2ebd13071546297))

### Bug Fixes

* **goals:** finish a goal when a replan is the last job to end, and on a run's start ([abd16ed](https://github.com/Soleone/factory/commit/abd16ed41889a044d3f3b6383e55b55405caf7c9))
* **loop:** untiered jobs run only on the run's agent workers, not on tier presets ([40a9282](https://github.com/Soleone/factory/commit/40a9282e93c27c35c51864a27429345e145ee7fb))
* **ui:** drop the count from the Goals tab ([86b596a](https://github.com/Soleone/factory/commit/86b596a2de0f8b9998e74dc65b8ecccce43a4f76))
* **ui:** drop the count from the Queue tab ([670b865](https://github.com/Soleone/factory/commit/670b86598912aca2ac7d1b534af7c0c92a1125d7))

## [0.3.3](https://github.com/Soleone/factory/compare/v0.3.2...v0.3.3) (2026-11-21)

### Features

* **queue:** start a job of your own from the page, and say what approving a goal does ([985a758](https://github.com/Soleone/factory/commit/985a7587923bcfa9f07136194b7ad60e00447c16))

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
