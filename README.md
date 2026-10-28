# 25 years of bioinformatics in Spain 2000-25: progress, achievements and scientific landscape

An interactive research explorer for bioinformatics publications associated with Spain between 2000 and 2025. Browse publications, explore thematic relationships and inspect clustering results through a shared interactive map.


<p align="center">
  <a href="https://jdelasrivas-lab.github.io/bioinformatics-spain-2000-2025/">
    <img src="https://img.shields.io/badge/Open%20explorer%20%E2%86%97-2D6A4F?style=for-the-badge" alt="Open explorer" width="250">
  </a>
</p>

## ⚙️ Methodology

The thematic analysis uses BiomedBERT, a BERT-based language model pretrained on biomedical literature, to represent article content. These representations support thematic clustering, while a shared UMAP projection enables interactive exploration of relationships between publications.

Alternative clustering solutions are compared to examine thematic structure and stability. The selected Leiden solution identifies five broad research groups and 15 subtopics. Topic boundaries are exploratory and may overlap, reflecting connections between research areas.

## ✍️ Authors

Julen Santiago-Agredano<sup>1,&#42;</sup>, Emma Pérez-García<sup>2,3,&#42;</sup>, Fabian Robledo-Yagüe<sup>1</sup>, Ana Conesa<sup>1,&#42;</sup> and Javier De Las Rivas<sup>2,3</sup>.

### Affiliations

1. Institute for Integrative Systems Biology (I2SysBio), Consejo Superior de Investigaciones Científicas (CSIC), 46980 Valencia, Spain.

2. Cancer Research Center (CiC, CSIC/USAL), Consejo Superior de Investigaciones Científicas (CSIC) and University of Salamanca (USAL), 37007 Salamanca, Spain.

3. Instituto de Investigación Biomédica de Salamanca (IBSAL), CANC-14, Complejo Asistencial Universitario de Salamanca, 37007 Salamanca, Spain.

<sup>*</sup> *These authors contributed equally to this work.*

## ⏬ Running the explorer

Run these commands from the repository root:

| Command | Description |
| --- | --- |
| `npm start` | Start the local web server |
| `npm test` | Run the automated tests |
| `npm run check` | Validate the project and run all tests |

After starting the server, open [http://127.0.0.1:8000](http://127.0.0.1:8000) in your browser.

## Reference

For **Microsoft BiomedBERT**, originally released as **PubMedBERT**, see:

Gu, Y., Tinn, R., Cheng, H., Lucas, M., Usuyama, N., Liu, X., Naumann, T., Gao, J., & Poon, H. (2022). **Domain-Specific Language Model Pretraining for Biomedical Natural Language Processing.** *ACM Transactions on Computing for Healthcare*, 3(1), Article 2. [https://doi.org/10.1145/3458754](https://doi.org/10.1145/3458754).

An open-access preprint is available at [arXiv:2007.15779](https://arxiv.org/abs/2007.15779).

Python usage examples are available in the [official BiomedBERT documentation](https://huggingface.co/microsoft/BiomedNLP-BiomedBERT-base-uncased-abstract).
