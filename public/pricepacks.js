/* Ready lists for Settings > Invoice. Each list is a specialty with its common procedures and services.
   Picking one copies the names into the clinic's own price list; prices are left blank for the clinic to fill in. */
(function(root){
const P=[
 {id:"den",n:"Dental",d:"Check-ups, cleaning, fillings, root canal, crowns and X-rays",m:`
General visit / check-up
Consultation
Scaling
Cleaning and polishing
Deep cleaning (curettage)
Tooth filling (composite)
Temporary filling
Root canal treatment
Re-root canal treatment
Tooth extraction
Surgical extraction (wisdom tooth)
Crown (metal ceramic)
Crown (zirconia)
Post and core
Complete denture
Partial denture
Dental implant
Braces (orthodontic treatment)
Teeth whitening
Fluoride application
Pit and fissure sealant
Dental X-ray (IOPA)
OPG X-ray`},
 {id:"lab",n:"Lab tests",d:"Blood, sugar, thyroid, kidney, liver, urine and fever panels",m:`
CBC (complete blood count)
ESR
Blood sugar (random)
Blood sugar (fasting)
Blood sugar (post-prandial)
HbA1c
Lipid profile
Liver function test (LFT)
Kidney function test (KFT)
Serum creatinine
Thyroid profile (T3, T4, TSH)
TSH
Urine routine
Uric acid
Serum electrolytes
Vitamin D
Vitamin B12
CRP
Dengue NS1
Malaria test
Widal test
ECG
Home sample collection`},
 {id:"gen",n:"General medicine",d:"Consultations, injections, drips, dressings and certificates",m:`
Consultation
Follow-up consultation
Emergency consultation
Online / video consultation
Home visit
Injection (IM / IV)
IV fluids / drip
Nebulisation
Dressing (small)
Dressing (large)
Suturing
Suture removal
Incision and drainage
Ear wax removal
BP and sugar check
ECG
Medical certificate
Fitness certificate`},
 {id:"phy",n:"Physiotherapy",d:"Assessment, electrotherapy, exercise, home visits and rehab",m:`
Assessment (first visit)
Physiotherapy session
Home physiotherapy visit
IFT (interferential therapy)
TENS
Ultrasound therapy
Short wave diathermy
Traction (cervical / lumbar)
Hot pack / cold pack
Exercise therapy
Manual therapy
Dry needling
Kinesio taping
Post-operative rehabilitation
Stroke rehabilitation session
Package (10 sessions)`},
 {id:"psy",n:"Psychiatry",d:"Consultations, therapy, counselling and assessments",m:`
Consultation
Follow-up consultation
Online / video consultation
Psychotherapy session
Counselling session
Family counselling
De-addiction counselling
Psychological assessment
IQ assessment
Personality assessment
Medical certificate`},
 {id:"skin",n:"Skin / Dermatology",d:"Consultations, peels, laser, minor skin procedures",m:`
Consultation
Follow-up consultation
Chemical peel
Laser hair removal session
Acne extraction
Microdermabrasion
Hydrafacial
PRP session
Wart removal (cautery)
Mole removal
Skin biopsy
Patch test`}];
root.PRICEPACKS=P.map(p=>({id:p.id,n:p.n,d:p.d,m:p.m.trim().split("\n").map(s=>s.trim()).filter(Boolean)}));
})(this);
