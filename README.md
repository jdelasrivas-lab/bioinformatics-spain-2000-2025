# Bioinformatics in Spain (2000–2025)

The **Bioinformatics in Spain Research Explorer** is an interactive companion to the study of bioinformatics research in Spain between 2000 and 2025. It brings together publication records, BiomedBERT-based thematic representations and clustering results to explore research topics and their relationships.

The application provides a shared UMAP map, a searchable publication browser, comparisons of clustering solutions and a workspace for reviewing topic names and scope. The bundled dataset contains **5,914 publications**, including **5,785 mapped records**, and **22 global clustering solutions**.

[**Open the interactive explorer →**](https://jdelasrivas-lab.github.io/bioinformatics-spain-2000-2025/)

## Rationale

Bioinformatics connects computational methods with biological questions across many research areas. Its development is therefore reflected both in the production of publications and in the methods, resources and applications that these publications share.

An interactive representation of the literature helps examine this thematic structure, move between broad research groups and individual articles, and assess the evidence supporting alternative groupings. This explorer brings these views together to support the interpretation of the scientific landscape and the review of proposed topic boundaries.

## Methodology

The explorer presents the results of a thematic analysis based on **BiomedBERT article representations**. A shared **UMAP projection** provides the visual coordinates, while Leiden, K-means and PCA-assisted K-means solutions provide alternative group assignments. All solutions are displayed on the same map so that changing the grouping preserves the underlying coordinates.

Clustering alternatives are compared using silhouette values in the original embedding space and adjusted Rand index (ARI) across random seeds. The proposed hierarchy uses **Leiden at resolution 0.5**, with five broad groups and 15 local subtopics across groups 1–4; group 5 remains undivided. The supplied evaluation includes 110 global runs and 125 local runs.

Leiden at resolution 0.5 achieves the highest mean global silhouette among the compared solutions (**0.16820**), although this low positive value indicates weak separation and thematic overlap. The interdisciplinary nature of bioinformatics, where methods and biological questions cross research areas, is one possible explanation for this overlap. Representation and clustering choices may also contribute. Topic names and boundaries are therefore treated as exploratory interpretations, supported by terms, example articles and expert review.

The website displays the supplied research outputs. Publication records, coordinates, assignments and numerical metrics are retained in the [research corpus](site/data/corpus.json), with analysis provenance available in the interface and as a JSON export. This provenance records model settings, analysis parameters, random seeds, software versions and file fingerprints. Reproducing the analysis also requires the corresponding source data, trained model and analysis scripts.

## ✍️ Authors

Julen Santiago-Agredano<sup>1,*</sup>, Emma Pérez-García<sup>2,3,*</sup>, Fabian Robledo-Yagüe<sup>1</sup>, Ana Conesa<sup>1,*</sup> and Javier De Las Rivas<sup>2,3</sup>.

### Affiliations

1. Institute for Integrative Systems Biology (I2SysBio), Consejo Superior de Investigaciones Científicas (CSIC), 46980 Valencia, Spain.

2. Cancer Research Center (CiC, CSIC/USAL), Consejo Superior de Investigaciones Científicas (CSIC) and University of Salamanca (USAL), 37007 Salamanca, Spain.

3. Instituto de Investigación Biomédica de Salamanca (IBSAL), CANC-14, Complejo Asistencial Universitario de Salamanca, 37007 Salamanca, Spain.

<sup>*</sup> These authors contributed equally to this work.

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
