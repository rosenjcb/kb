#!/usr/bin/env python3
import json
import sys
import warnings
from typing import Any

import hdbscan
import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

warnings.filterwarnings("ignore", category=FutureWarning)


def main() -> None:
    payload = json.load(sys.stdin)
    mode = payload.get("mode")
    if mode == "discover":
        emit(
            {
                "categories": discover_categories(
                    payload.get("facts", []), int(payload.get("max_categories", 8))
                )
            }
        )
        return
    if mode == "discover_and_assign":
        categories = discover_categories(payload.get("facts", []), int(payload.get("max_categories", 8)))
        assignments = assign_categories(
            payload.get("facts", []),
            [
                {
                    "id": slugify_name(category["name"]),
                    "text": " ".join(
                        [
                            category["name"],
                            category["description"],
                            *category["representative_terms"],
                        ]
                    ),
                }
                for category in categories
            ],
            float(payload.get("threshold", 0.72)),
        )
        emit({"categories": categories, "assignments": assignments})
        return
    if mode == "assign":
        emit(
            {
                "assignments": assign_categories(
                    payload.get("facts", []),
                    payload.get("categories", []),
                    float(payload.get("threshold", 0.72)),
                    bool(payload.get("force_assign", False)),
                )
            }
        )
        return
    raise SystemExit(f"unsupported mode: {mode}")


def discover_categories(facts: list[dict[str, Any]], max_categories: int) -> list[dict[str, Any]]:
    texts = [normalize_text(fact.get("text", "")) for fact in facts]
    indexed = [(fact.get("id", ""), text) for fact, text in zip(facts, texts) if text]
    if len(indexed) < 2:
        return []

    fact_ids = [fact_id for fact_id, _ in indexed]
    corpus = [text for _, text in indexed]
    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=2048)
    matrix = vectorizer.fit_transform(corpus)
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=max(2, min(5, len(corpus) // 3 or 2)),
        min_samples=1,
        allow_single_cluster=True,
        metric="euclidean",
        cluster_selection_method="eom",
    )
    labels = clusterer.fit_predict(matrix.toarray())
    feature_names = np.array(vectorizer.get_feature_names_out())

    categories: list[dict[str, Any]] = []
    for label in sorted(set(labels)):
        if label < 0:
            continue
        indices = [idx for idx, current_label in enumerate(labels) if current_label == label]
        if len(indices) < 2:
            continue
        cluster_matrix = matrix[indices]
        centroid = np.asarray(cluster_matrix.mean(axis=0)).ravel()
        top_term_indices = centroid.argsort()[::-1][:6]
        representative_terms = [term for term in feature_names[top_term_indices].tolist() if term]
        if not representative_terms:
            continue
        name_terms = choose_name_terms(representative_terms)
        name = " ".join(term.title() for term in name_terms)
        description = f"Facts about {', '.join(representative_terms[:3])}"
        categories.append(
            {
                "name": name,
                "description": description,
                "representative_terms": representative_terms,
                "centroid_vector": normalize_vector(centroid).tolist(),
                "fact_ids": [fact_ids[index] for index in indices],
            }
        )

    categories.sort(key=lambda category: len(category["fact_ids"]), reverse=True)
    return categories[:max_categories]


def assign_categories(
    facts: list[dict[str, Any]], categories: list[dict[str, Any]], threshold: float, force_assign: bool = False
) -> list[dict[str, Any]]:
    fact_rows = [(fact.get("id", ""), normalize_text(fact.get("text", ""))) for fact in facts]
    fact_rows = [(fact_id, text) for fact_id, text in fact_rows if fact_id and text]
    category_rows = [
        (category.get("id", ""), normalize_text(category.get("text", ""))) for category in categories
    ]
    category_rows = [(category_id, text) for category_id, text in category_rows if category_id and text]
    if not fact_rows or not category_rows:
        return []

    corpus = [text for _, text in fact_rows] + [text for _, text in category_rows]
    vectorizer = TfidfVectorizer(stop_words="english", ngram_range=(1, 2), max_features=2048)
    matrix = vectorizer.fit_transform(corpus)
    fact_matrix = matrix[: len(fact_rows)]
    category_matrix = matrix[len(fact_rows) :]
    similarities = cosine_similarity(fact_matrix, category_matrix)

    assignments: list[dict[str, Any]] = []
    category_ids = [category_id for category_id, _ in category_rows]
    for row_index, (fact_id, _) in enumerate(fact_rows):
        scores = similarities[row_index].tolist()
        pairs = [
            {"category_id": category_ids[col_index], "score": float(score)}
            for col_index, score in enumerate(scores)
            if score >= threshold
        ]
        pairs.sort(key=lambda item: item["score"], reverse=True)
        if not pairs and force_assign:
            best_col = int(np.argmax(scores))
            pairs = [{"category_id": category_ids[best_col], "score": float(scores[best_col])}]
        if pairs:
            assignments.append({"fact_id": fact_id, "assignments": pairs[:3]})
    return assignments


def normalize_text(value: Any) -> str:
    text = str(value or "").strip()
    return " ".join(text.split())


def normalize_vector(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    if norm == 0:
        return vector
    return vector / norm


def choose_name_terms(representative_terms: list[str]) -> list[str]:
    chosen: list[str] = []
    seen_words: set[str] = set()
    for term in representative_terms:
        words = [word for word in term.split() if word]
        if not words:
            continue
        if any(word in seen_words for word in words):
            continue
        chosen.append(term)
        seen_words.update(words)
        if len(chosen) == 2:
            break
    return chosen or representative_terms[:2]


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload))


def slugify_name(value: str) -> str:
    lowered = value.lower()
    slug = "-".join(part for part in "".join(ch if ch.isalnum() else " " for ch in lowered).split() if part)
    return f"category-{slug}" if slug else "category-inferred"


if __name__ == "__main__":
    main()
