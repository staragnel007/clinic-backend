/* Ready medicine lists for Settings > Prescription. A doctor copies a list into their own clinic, then edits or switches
   off anything; nothing here is shared back. One medicine per line: type | name | strength | usual dosage | intake | days.
   Dosage, intake and days are typical adult starting points for the doctor to review, not prescribing advice. */
(function(root){
const P=[
{id:"psy",n:"Psychiatry",d:"Antidepressants, antipsychotics, mood stabilisers and sleep aids",m:`
Tab|Escitalopram|5 mg|1-0-0|After food|30
Tab|Escitalopram|10 mg|1-0-0|After food|30
Tab|Escitalopram|20 mg|1-0-0|After food|30
Tab|Sertraline|50 mg|1-0-0|After food|30
Tab|Sertraline|100 mg|1-0-0|After food|30
Cap|Fluoxetine|20 mg|1-0-0|After food|30
Tab|Paroxetine CR|12.5 mg|1-0-0|After food|30
Tab|Paroxetine CR|25 mg|1-0-0|After food|30
Tab|Fluvoxamine|50 mg|0-0-1|After food|30
Cap|Venlafaxine ER|75 mg|1-0-0|After food|30
Cap|Duloxetine|30 mg|1-0-0|After food|30
Tab|Desvenlafaxine ER|50 mg|1-0-0|After food|30
Tab|Vortioxetine|10 mg|1-0-0|After food|30
Tab|Mirtazapine|7.5 mg|0-0-1|At bedtime|30
Tab|Mirtazapine|15 mg|0-0-1|At bedtime|30
Tab|Amitriptyline|10 mg|0-0-1|At bedtime|30
Tab|Amitriptyline|25 mg|0-0-1|At bedtime|30
Tab|Clomipramine|25 mg|0-0-1|At bedtime|30
Tab|Bupropion SR|150 mg|1-0-0|After food|30
Tab|Trazodone|50 mg|0-0-1|At bedtime|30
Tab|Agomelatine|25 mg|0-0-1|At bedtime|30
Tab|Olanzapine|5 mg|0-0-1|At bedtime|30
Tab|Olanzapine|10 mg|0-0-1|At bedtime|30
Tab|Risperidone|1 mg|0-0-1|After food|30
Tab|Risperidone|2 mg|1-0-1|After food|30
Tab|Quetiapine|25 mg|0-0-1|At bedtime|30
Tab|Quetiapine|100 mg|0-0-1|At bedtime|30
Tab|Aripiprazole|5 mg|1-0-0|After food|30
Tab|Aripiprazole|10 mg|1-0-0|After food|30
Tab|Haloperidol|5 mg|1-0-1|After food|30
Tab|Amisulpride|100 mg|1-0-1|After food|30
Tab|Clozapine|25 mg|0-0-1|At bedtime|30
Tab|Paliperidone ER|3 mg|1-0-0|After food|30
Tab|Trihexyphenidyl|2 mg|1-0-0|After food|30
Tab|Divalproex ER|500 mg|0-0-1|After food|30
Tab|Lithium Carbonate|300 mg|1-0-1|After food|30
Tab|Lamotrigine|25 mg|1-0-0|After food|30
Tab|Lamotrigine|50 mg|1-0-0|After food|30
Tab|Carbamazepine CR|200 mg|1-0-1|After food|30
Tab|Oxcarbazepine|300 mg|1-0-1|After food|30
Tab|Clonazepam|0.25 mg|0-0-1|At bedtime|15
Tab|Clonazepam|0.5 mg|0-0-1|At bedtime|15
Tab|Alprazolam|0.25 mg|0-0-1|At bedtime|15
Tab|Lorazepam|1 mg|0-0-1|At bedtime|15
Tab|Etizolam|0.5 mg|0-0-1|At bedtime|15
Tab|Zolpidem|5 mg|0-0-1|At bedtime|7
Tab|Melatonin|3 mg|0-0-1|At bedtime|30
Tab|Propranolol|10 mg|1-0-1|After food|30`},
{id:"den",n:"Dental",d:"Antibiotics, analgesics and the gels a dental chair reaches for",m:`
Cap|Amoxicillin|500 mg|1-1-1|After food|5
Tab|Amoxicillin + Clavulanic Acid|625 mg|1-0-1|After food|5
Tab|Metronidazole|400 mg|1-1-1|After food|5
Tab|Ornidazole|500 mg|1-0-1|After food|5
Cap|Clindamycin|300 mg|1-1-1|After food|5
Tab|Azithromycin|500 mg|1-0-0|After food|3
Tab|Ibuprofen|400 mg|1-0-1|After food|3
Tab|Aceclofenac + Paracetamol|100/325 mg|1-0-1|After food|3
Tab|Diclofenac + Paracetamol|50/325 mg|1-0-1|After food|3
Tab|Ketorolac|10 mg|1-0-1|After food|3
Tab|Paracetamol|650 mg|1-0-1|After food|3
Tab|Tramadol + Paracetamol|37.5/325 mg|1-0-1|After food|3
Tab|Serratiopeptidase|10 mg|1-0-1|After food|5
Tab|Pantoprazole|40 mg|1-0-0|Before food|5
Gel|Choline Salicylate + Lignocaine||1-1-1|Local application|5
Gel|Triamcinolone Acetonide|0.1%|1-1-1|Local application|5
Mouthwash|Chlorhexidine|0.2%|1-0-1|Local application|7
Paste|Potassium Nitrate|5%|1-0-1|Local application|30`},
{id:"skin",n:"Skin / Dermatology",d:"Acne, fungal, pigmentation and hair medication",m:`
Tab|Cetirizine|10 mg|0-0-1|At bedtime|7
Tab|Levocetirizine|5 mg|0-0-1|At bedtime|7
Tab|Fexofenadine|120 mg|1-0-0|After food|7
Tab|Hydroxyzine|25 mg|0-0-1|At bedtime|7
Cap|Itraconazole|100 mg|1-0-1|After food|14
Tab|Terbinafine|250 mg|1-0-0|After food|14
Cap|Doxycycline|100 mg|1-0-0|After food|30
Cap|Isotretinoin|20 mg|1-0-0|After food|30
Gel|Adapalene|0.1%|0-0-1|Local application|30
Gel|Clindamycin|1%|1-0-1|Local application|30
Cream|Luliconazole|1%|0-0-1|Local application|14
Cream|Ketoconazole|2%|1-0-1|Local application|14
Cream|Mometasone|0.1%|1-0-0|Local application|7
Cream|Azelaic Acid|20%|0-0-1|Local application|30
Solution|Minoxidil|5%|1-0-1|Local application|90
Cream|Permethrin|5%|0-0-1|Local application|1`},
{id:"gp",n:"General practice",d:"Fever, infection, acidity, allergy and long-term medication",m:`
Tab|Paracetamol|500 mg|1-1-1|After food|3
Tab|Paracetamol|650 mg|1-0-1|After food|3
Tab|Ibuprofen|400 mg|1-0-1|After food|3
Cap|Amoxicillin|500 mg|1-1-1|After food|5
Tab|Amoxicillin + Clavulanic Acid|625 mg|1-0-1|After food|5
Tab|Azithromycin|500 mg|1-0-0|After food|3
Tab|Cefixime|200 mg|1-0-1|After food|5
Tab|Ciprofloxacin|500 mg|1-0-1|After food|5
Cap|Nitrofurantoin SR|100 mg|1-0-1|After food|5
Tab|Pantoprazole|40 mg|1-0-0|Before food|14
Tab|Domperidone|10 mg|1-1-1|Before food|5
Tab|Ondansetron|4 mg|1-0-1|Before food|3
Syp|Aluminium + Magnesium Hydroxide|10 ml|1-1-1|After food|7
Tab|Cetirizine|10 mg|0-0-1|At bedtime|5
Tab|Montelukast + Levocetirizine|10/5 mg|0-0-1|At bedtime|7
Syp|Dextromethorphan + Chlorpheniramine|5 ml|1-1-1|After food|5
Sachet|ORS||As needed|As needed|3
Tab|Metformin|500 mg|1-0-1|After food|30
Tab|Amlodipine|5 mg|1-0-0|After food|30
Cap|Cholecalciferol|60000 IU|Once a week|After food|56`},
{id:"dm",n:"Diabetes",d:"Tablets, insulins and GLP-1s for diabetes, with BP, lipid and nerve medicines, by generic name",m:`
Tab|Metformin|500 mg|1-0-1|After food|30
Tab|Metformin SR|1000 mg|0-0-1|After food|30
Tab|Glimepiride|1 mg|1-0-0|Before food|30
Tab|Glimepiride|2 mg|1-0-0|Before food|30
Tab|Gliclazide MR|60 mg|1-0-0|Before food|30
Tab|Glimepiride + Metformin SR|1/500 mg|1-0-0|Before food|30
Tab|Sitagliptin|100 mg|1-0-0|After food|30
Tab|Vildagliptin|50 mg|1-0-1|After food|30
Tab|Teneligliptin|20 mg|1-0-0|After food|30
Tab|Linagliptin|5 mg|1-0-0|After food|30
Tab|Sitagliptin + Metformin|50/500 mg|1-0-1|After food|30
Tab|Dapagliflozin|10 mg|1-0-0|After food|30
Tab|Empagliflozin|10 mg|1-0-0|After food|30
Tab|Pioglitazone|15 mg|1-0-0|After food|30
Tab|Voglibose|0.2 mg|1-1-1|With food|30
Tab|Semaglutide|3 mg|1-0-0|Empty stomach|30
Inj|Insulin Glargine|100 IU/ml|0-0-10 U|At bedtime|30
Inj|Insulin Aspart|100 IU/ml|6-6-6 U|Before food|30
Inj|Premixed Human Insulin 30/70|40 IU/ml|10-0-8 U|Before food|30
Inj|Semaglutide|0.25 mg|Once a week||28
Inj|Dulaglutide|0.75 mg|Once a week||28
Tab|Telmisartan|40 mg|1-0-0|After food|30
Tab|Telmisartan + Hydrochlorothiazide|40/12.5 mg|1-0-0|After food|30
Tab|Amlodipine|5 mg|1-0-0|After food|30
Tab|Atorvastatin|10 mg|0-0-1|After food|30
Tab|Rosuvastatin|10 mg|0-0-1|After food|30
Tab|Fenofibrate|160 mg|0-0-1|After food|30
Tab|Aspirin|75 mg|1-0-0|After food|30
Tab|Methylcobalamin|1500 mcg|1-0-0|After food|30
Cap|Pregabalin|75 mg|0-0-1|At bedtime|30`}];
root.MEDPACKS=P.map(p=>({id:p.id,n:p.n,d:p.d,m:p.m.trim().split("\n").map(l=>{const [t,n,s,d,i,u]=l.split("|");return {t,n,s,d,i,u}})}));
})(this);
