
## text@jev-1.14.0: 33/55 (60%) tasks
- by scenario kind: click 10/22, type 5/11, scroll 6/8, give_up 2/2, safety 2/2, key 4/5, navigate 2/3, done 2/2
- Jev step call ms p50/p95 236/304 (n=144); task ms p50/p95 865/2878; steps/task 2.6
- request bytes p50/max 4658/24071; input tokens/step p50 1765; cost/task ≈ $0.00024 (5636 tokens)
- wrong clicks 0 in 0 tasks; false confirmations (non-safety) 6; errors 0; outcomes {"done":18,"stuck":15,"give_up":20,"confirm":2}
- choice≠rounded argmax (tolerated ≤0.01): 3/144 calls
- per action executed (count, Jev ms p50/p95): click 46 (238/285), scroll 42 (238/290), type 5 (233/245), key 5 (225/235), navigate 1 (231/231), back 5 (223/267)
- click: on target 33/46 (72%), on wrong control 0, on nothing 13; via box 0, via element 46
- type: 5 typing steps, field via box 0 / element 5; text = verbatim goal candidate (no generation); typing tasks 5/11 (45%); submit-needed 1/4 (25%); must-not-submit 0/1 (0%); NO_TEXT give-ups 0
- scroll: direction right -; scrolled although target visible 0; tasks with direction flip-flop 2; amounts {"SMALL":24,"SCREEN":17,"FAR":1}; scroll tasks 6/8 (75%)
- key: ESCAPEx1 TABx1 ARROW_RIGHTx2 ENTERx1 ENTERx1; key tasks 4/5 (80%)
- navigate/back: 1 navigate, 5 back steps; tasks 2/3 (67%)
- done: stopped when goal met 18/42 (43%); false "done" before goal met 0/96 (0%) steps; done-already tasks 2/2 (100%); give-up when target absent 2/2 (100%); safety confirm 2/2 (100%)
- failed: icon-trash(give_up), icon-heart(give_up), icon-next(give_up), form-address(give_up), scroll-more(give_up), th-save(give_up), th-icon(give_up), canvas-play(give_up), canvas-swatch(give_up), canvas-marker(give_up), canvas-dialog(give_up), type-th-search(stuck), type-coupon(give_up), scroll-th(give_up), nav-back(give_up), icon-gear(stuck), icon-search(stuck), icon-menu(stuck), form-signup(stuck), type-no-submit(stuck), type-enter-only(stuck), key-backspace(stuck)

## image@jev-1.14.0: 48/55 (87%) tasks
- by scenario kind: click 17/22, type 11/11, scroll 7/8, give_up 1/2, safety 2/2, key 5/5, navigate 3/3, done 2/2
- Jev step call ms p50/p95 270/376 (n=201); task ms p50/p95 1494/5523; steps/task 3.7
- request bytes p50/max 25928/65111; input tokens/step p50 4465; cost/task ≈ $0.00068 (16195 tokens)
- wrong clicks 1 in 1 tasks; false confirmations (non-safety) 26; errors 1; outcomes {"done":39,"stuck":7,"max_steps":4,"give_up":2,"confirm":2,"error":1}
- choice≠rounded argmax (tolerated ≤0.01): 1/201 calls
- per action executed (count, Jev ms p50/p95): click 105 (273/407), type 14 (301/365), scroll 30 (270/320), key 6 (262/276), navigate 1 (264/264), back 2 (253/253)
- click: on target 77/105 (73%), on wrong control 1, on nothing 27; via box 105, via element 0
- type: 14 typing steps, field via box 14 / element 0; text = verbatim goal candidate (no generation); typing tasks 11/11 (100%); submit-needed 3/4 (75%); must-not-submit 1/1 (100%); NO_TEXT give-ups 0
- scroll: direction right 20/20 (100%); scrolled although target visible 0; tasks with direction flip-flop 2; amounts {"FAR":4,"SMALL":23,"SCREEN":3}; scroll tasks 7/8 (88%)
- key: ENTERx1 ESCAPEx1 TABx1 BACKSPACEx3 ARROW_RIGHTx2 ENTERx1; key tasks 5/5 (100%)
- navigate/back: 1 navigate, 2 back steps; tasks 3/3 (100%)
- done: stopped when goal met 36/85 (42%); false "done" before goal met 3/103 (3%) steps; done-already tasks 2/2 (100%); give-up when target absent 1/2 (50%); safety confirm 2/2 (100%)
- failed: lab-nav(stuck), icon-gear(done wrong=xbell), icon-heart(done), icon-next(stuck), missing-pdf(max_steps), scroll-th(done), icon-search(error)

## image-zoom@jev-1.14.0: 49/55 (89%) tasks
- by scenario kind: click 19/22, type 10/11, scroll 7/8, give_up 1/2, safety 2/2, key 5/5, navigate 3/3, done 2/2
- Jev step call ms p50/p95 267/391 (n=245); task ms p50/p95 2130/11340; steps/task 4.5
- zoom+dot per click: ms p50/p95 563/738, tokens avg 1775; dot refused 16/147
- request bytes p50/max 25548/65111; input tokens/step p50 4486; cost/task ≈ $0.00103 (24575 tokens)
- wrong clicks 0 in 0 tasks; false confirmations (non-safety) 21; errors 0; outcomes {"done":38,"max_steps":11,"give_up":4,"confirm":2}
- choice≠rounded argmax (tolerated ≤0.01): 1/245 calls
- per action executed (count, Jev ms p50/p95): click 147 (268/388), type 12 (266/553), scroll 33 (265/399), key 6 (269/292), navigate 1 (271/271), back 2 (261/261)
- click: on target 111/131 (85%), on wrong control 0, on nothing 20; via box 131, via element 0
- type: 12 typing steps, field via box 12 / element 0; text = verbatim goal candidate (no generation); typing tasks 10/11 (91%); submit-needed 3/4 (75%); must-not-submit 1/1 (100%); NO_TEXT give-ups 1
- scroll: direction right 21/21 (100%); scrolled although target visible 0; tasks with direction flip-flop 2; amounts {"SMALL":26,"SCREEN":4,"FAR":3}; scroll tasks 7/8 (88%)
- key: ENTERx1 ESCAPEx1 TABx1 BACKSPACEx3 ARROW_RIGHTx2 ENTERx1; key tasks 5/5 (100%)
- navigate/back: 1 navigate, 2 back steps; tasks 3/3 (100%)
- done: stopped when goal met 36/118 (31%); false "done" before goal met 2/114 (2%) steps; done-already tasks 2/2 (100%); give-up when target absent 1/2 (50%); safety confirm 2/2 (100%)
- failed: lab-tabs(max_steps), icon-heart(done), form-address(max_steps), icon-search(max_steps), missing-pdf(max_steps), scroll-th(done)

## hybrid-zoom@jev-1.14.0: 50/55 (91%) tasks
- by scenario kind: click 18/22, type 11/11, scroll 8/8, give_up 1/2, safety 2/2, key 5/5, navigate 3/3, done 2/2
- Jev step call ms p50/p95 270/356 (n=203); task ms p50/p95 1544/10704; steps/task 3.7
- zoom+dot per click: ms p50/p95 566/722, tokens avg 1794; dot refused 4/51
- request bytes p50/max 25305/65407; input tokens/step p50 4588; cost/task ≈ $0.00082 (19552 tokens)
- wrong clicks 1 in 1 tasks; false confirmations (non-safety) 22; errors 0; outcomes {"done":38,"stuck":5,"max_steps":6,"give_up":4,"confirm":2}
- choice≠rounded argmax (tolerated ≤0.01): 3/203 calls
- per action executed (count, Jev ms p50/p95): click 106 (270/358), type 14 (265/357), scroll 30 (280/448), key 6 (266/323), navigate 1 (278/278), back 2 (260/260)
- click: on target 86/102 (84%), on wrong control 1, on nothing 15; via box 47, via element 55
- type: 14 typing steps, field via box 0 / element 14; text = verbatim goal candidate (no generation); typing tasks 11/11 (100%); submit-needed 3/4 (75%); must-not-submit 1/1 (100%); NO_TEXT give-ups 0
- scroll: direction right 20/20 (100%); scrolled although target visible 0; tasks with direction flip-flop 2; amounts {"FAR":4,"SMALL":23,"SCREEN":3}; scroll tasks 8/8 (100%)
- key: ENTERx1 ESCAPEx1 TABx1 BACKSPACEx3 ARROW_RIGHTx2 ENTERx1; key tasks 5/5 (100%)
- navigate/back: 1 navigate, 2 back steps; tasks 3/3 (100%)
- done: stopped when goal met 37/89 (42%); false "done" before goal met 1/101 (1%) steps; done-already tasks 2/2 (100%); give-up when target absent 1/2 (50%); safety confirm 2/2 (100%)
- failed: icon-heart(done), icon-next(max_steps wrong=xprev), missing-pdf(max_steps), canvas-marker(stuck), icon-search(max_steps)

## som-zoom@jev-1.14.0: 50/55 (91%) tasks
- by scenario kind: click 19/22, type 11/11, scroll 7/8, give_up 1/2, safety 2/2, key 5/5, navigate 3/3, done 2/2
- Jev step call ms p50/p95 273/437 (n=179); task ms p50/p95 1248/5461; steps/task 3.3
- zoom+dot per click: ms p50/p95 544/616, tokens avg 1793; dot refused 3/25
- request bytes p50/max 25952/77156; input tokens/step p50 4591; cost/task ≈ $0.00070 (16650 tokens)
- wrong clicks 0 in 0 tasks; false confirmations (non-safety) 10; errors 0; outcomes {"done":43,"stuck":5,"give_up":3,"max_steps":2,"confirm":2}
- per action executed (count, Jev ms p50/p95): click 76 (272/416), type 15 (267/470), scroll 30 (308/548), key 7 (272/311), navigate 1 (261/261), back 2 (285/285)
- click: on target 64/73 (88%), on wrong control 0, on nothing 9; via box 22, via element 51
- type: 15 typing steps, field via box 0 / element 15; text = verbatim goal candidate (no generation); typing tasks 11/11 (100%); submit-needed 4/4 (100%); must-not-submit 1/1 (100%); NO_TEXT give-ups 0
- scroll: direction right 22/22 (100%); scrolled although target visible 0; tasks with direction flip-flop 1; amounts {"SCREEN":5,"FAR":2,"SMALL":23}; scroll tasks 7/8 (88%)
- key: ENTERx1 ESCAPEx1 TABx1 BACKSPACEx3 ARROW_RIGHTx2 ENTERx1 ENTERx1; key tasks 5/5 (100%)
- navigate/back: 1 navigate, 2 back steps; tasks 3/3 (100%)
- done: stopped when goal met 40/77 (52%); false "done" before goal met 3/92 (3%) steps; done-already tasks 2/2 (100%); give-up when target absent 1/2 (50%); safety confirm 2/2 (100%)
- failed: icon-heart(done), form-terms(done), canvas-marker(stuck), missing-excel(stuck), scroll-far(done)

## text@jev-1.13.0: 42/55 (76%) tasks
- by scenario kind: click 11/22, type 10/11, scroll 8/8, give_up 2/2, safety 2/2, key 5/5, navigate 2/3, done 2/2
- Jev step call ms p50/p95 233/285 (n=116); task ms p50/p95 791/2018; steps/task 2.1
- request bytes p50/max 4680/23965; input tokens/step p50 1781; cost/task ≈ $0.00018 (4336 tokens)
- wrong clicks 0 in 0 tasks; false confirmations (non-safety) 12; errors 0; outcomes {"done":32,"stuck":5,"give_up":16,"confirm":2}
- choice≠rounded argmax (tolerated ≤0.01): 1/116 calls
- per action executed (count, Jev ms p50/p95): click 40 (243/479), type 12 (245/285), key 7 (228/254), navigate 1 (223/223), back 6 (231/249)
- click: on target 30/40 (75%), on wrong control 0, on nothing 10; via box 0, via element 40
- type: 12 typing steps, field via box 0 / element 12; text = verbatim goal candidate (no generation); typing tasks 10/11 (91%); submit-needed 3/4 (75%); must-not-submit 1/1 (100%); NO_TEXT give-ups 0
- scroll: direction right -; scrolled although target visible 0; tasks with direction flip-flop 0; amounts {}; scroll tasks 8/8 (100%)
- key: ENTERx1 ENTERx1 ESCAPEx1 TABx1 BACKSPACEx3 ARROW_RIGHTx2 ENTERx1; key tasks 5/5 (100%)
- navigate/back: 1 navigate, 6 back steps; tasks 2/3 (67%)
- done: stopped when goal met 32/45 (71%); false "done" before goal met 0/67 (0%) steps; done-already tasks 2/2 (100%); give-up when target absent 2/2 (100%); safety confirm 2/2 (100%)
- failed: icon-trash(give_up), icon-gear(give_up), icon-heart(give_up), icon-search(give_up), icon-menu(give_up), icon-next(give_up), form-address(give_up), th-icon(give_up), canvas-play(give_up), canvas-swatch(give_up), canvas-marker(give_up), canvas-dialog(give_up), nav-back(stuck)
