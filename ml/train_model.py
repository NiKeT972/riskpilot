"""
RiskPilot - model training script.

Trains two Gradient Boosting models on historical project-task data and exports
them as JSON decision trees so the web app can run inference in the browser:

  1. Delay classifier  -> P(task finishes late)
  2. Slippage regressor -> expected delay as a fraction of planned duration

Historical data: 6,000 tasks generated from documented IT-project delay drivers
(see report, Section 4.2). Replace data/historical_tasks.csv with real exported
Jira / MS Project history to retrain on your own organisation's data.

Run:  python ml/train_model.py
"""
import json
import warnings
warnings.filterwarnings("ignore")
import os
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import (accuracy_score, roc_auc_score, precision_score, recall_score,
                             f1_score, confusion_matrix, roc_curve, mean_absolute_error)
from sklearn.linear_model import LogisticRegression

SEED = 42
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src", "model", "model.json")
DATA = os.path.join(HERE, "historical_tasks.csv")

FEATURES = ["complexity", "planned_days", "team_size", "team_experience_yrs",
            "resource_utilization", "num_dependencies", "requirement_changes",
            "budget_variance_pct", "progress_gap_pct", "vendor_dependent"]


def generate(n=6000, seed=SEED):
    rng = np.random.default_rng(seed)
    df = pd.DataFrame({
        "complexity": rng.integers(1, 6, n),
        "planned_days": rng.integers(1, 41, n),
        "team_size": rng.integers(1, 9, n),
        "team_experience_yrs": np.round(rng.gamma(2.2, 1.6, n), 1).clip(0.2, 15),
        "resource_utilization": rng.normal(85, 15, n).round().clip(40, 140),
        "num_dependencies": rng.poisson(1.6, n).clip(0, 7),
        "requirement_changes": rng.poisson(1.1, n).clip(0, 8),
        "budget_variance_pct": rng.normal(4, 9, n).round(1).clip(-15, 45),
        "progress_gap_pct": rng.gamma(1.4, 6, n).round(1).clip(0, 60),
        "vendor_dependent": rng.binomial(1, 0.25, n),
    })
    logit = (-3.5 + 0.45 * df.complexity + 0.025 * df.planned_days - 0.12 * df.team_size
             - 0.22 * df.team_experience_yrs + 0.035 * (df.resource_utilization - 85)
             + 0.30 * df.num_dependencies + 0.42 * df.requirement_changes
             + 0.035 * df.budget_variance_pct + 0.065 * df.progress_gap_pct
             + 0.75 * df.vendor_dependent
             + 0.015 * (df.resource_utilization > 105) * (df.resource_utilization - 105)
             # non-linear interaction effects observed in real projects
             + 0.9 * ((df.resource_utilization > 100) & (df.complexity >= 4))
             + 0.7 * ((df.vendor_dependent == 1) & (df.num_dependencies >= 3))
             + 0.8 * ((df.requirement_changes >= 3) & (df.team_experience_yrs < 2))
             - 0.6 * ((df.team_size >= 5) & (df.team_experience_yrs > 5))
             + rng.normal(0, 0.3, n))
    p = 1 / (1 + np.exp(-logit))
    df["delayed"] = rng.binomial(1, p)
    ratio = (0.08 + 0.35 * p) * rng.lognormal(0, 0.35, n)
    df["delay_ratio"] = np.where(df.delayed == 1, ratio.round(3), 0.0)
    return df


def export_trees(model, X_sample):
    """Compact depth-2 format per tree: [f0, t0, fL, tL, fR, tR, vLL, vLR, vRL, vRR]
    (fL/fR = -1 when that child is already a leaf; its value is then repeated)."""
    trees = []
    for est in model.estimators_[:, 0]:
        t = est.tree_
        L, R, F, T, V = t.children_left, t.children_right, t.feature, t.threshold, t.value[:, 0, 0]
        assert L[0] != -1, "root must split"
        row = [int(F[0]), round(float(T[0]), 3)]
        vals = []
        for c in (L[0], R[0]):
            if L[c] == -1:
                row += [-1, 0]; vals += [round(float(V[c]), 4)] * 2
            else:
                assert L[L[c]] == -1 and L[R[c]] == -1, "depth must be <= 2"
                row += [int(F[c]), round(float(T[c]), 3)]
                vals += [round(float(V[L[c]]), 4), round(float(V[R[c]]), 4)]
        trees.append(row + vals)
    lr = model.learning_rate
    raw_trees = sum(lr * est.predict(np.asarray(X_sample)) for est in model.estimators_[:, 0])
    raw_total = (model.decision_function(X_sample) if hasattr(model, "decision_function")
                 else model.predict(X_sample))
    base = float(np.mean(raw_total - raw_trees))
    return {"base": round(base, 5), "lr": lr, "trees": trees}


def js_raw(m, x):
    s = m["base"]
    for f0, t0, fl, tl, fr, tr, a, b, c, d in m["trees"]:
        if x[f0] <= t0:
            v = a if fl < 0 or x[fl] <= tl else b
        else:
            v = c if fr < 0 or x[fr] <= tr else d
        s += m["lr"] * v
    return s


def main():
    df = generate()
    df.to_csv(DATA, index=False)
    X, y = df[FEATURES].astype(float), df.delayed
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=0.25, random_state=SEED, stratify=y)
    w = np.where(ytr == 1, (ytr == 0).sum() / (ytr == 1).sum(), 1.0)

    clf = GradientBoostingClassifier(n_estimators=150, max_depth=2, learning_rate=0.1,
                                     subsample=0.8, random_state=SEED).fit(Xtr, ytr, sample_weight=w)
    prob = clf.predict_proba(Xte)[:, 1]
    pred = (prob >= 0.5).astype(int)

    # baseline for comparison: logistic regression
    lr_base = LogisticRegression(max_iter=2000, class_weight="balanced").fit(Xtr, ytr)
    lr_prob = lr_base.predict_proba(Xte)[:, 1]

    late = df[df.delayed == 1]
    Ltr, Lte = train_test_split(late, test_size=0.25, random_state=SEED)
    reg = GradientBoostingRegressor(n_estimators=60, max_depth=2, learning_rate=0.1,
                                    random_state=SEED).fit(Ltr[FEATURES].astype(float), Ltr.delay_ratio)
    mae = mean_absolute_error(Lte.delay_ratio, reg.predict(Lte[FEATURES].astype(float)))

    fpr, tpr, _ = roc_curve(yte, prob)
    idx = np.linspace(0, len(fpr) - 1, 40).astype(int)
    cm = confusion_matrix(yte, pred)

    out = {
        "features": FEATURES,
        "classifier": export_trees(clf, Xtr.iloc[:200]),
        "regressor": export_trees(reg, Ltr[FEATURES].astype(float).iloc[:200]),
        "metrics": {
            "accuracy": round(accuracy_score(yte, pred), 3),
            "roc_auc": round(roc_auc_score(yte, prob), 3),
            "precision": round(precision_score(yte, pred), 3),
            "recall": round(recall_score(yte, pred), 3),
            "f1": round(f1_score(yte, pred), 3),
            "baseline_logreg_auc": round(roc_auc_score(yte, lr_prob), 3),
            "baseline_logreg_f1": round(f1_score(yte, (lr_prob >= .5).astype(int)), 3),
            "regressor_mae_ratio": round(mae, 3),
            "train_size": int(len(Xtr)), "test_size": int(len(Xte)),
            "delay_rate": round(float(y.mean()), 3),
        },
        "confusion": cm.tolist(),
        "roc": [[round(float(fpr[i]), 3), round(float(tpr[i]), 3)] for i in idx],
        "importance": {f: round(float(v), 3) for f, v in zip(FEATURES, clf.feature_importances_)},
        "healthy": {f: round(float(X[f].quantile(q)), 2) for f, q in zip(
            FEATURES, [.25, .25, .75, .75, .25, .25, .25, .25, .25, .25])},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))

    # verify JS-style inference matches sklearn
    xs = Xte.values[:300]
    js_p = 1 / (1 + np.exp(-np.array([js_raw(out["classifier"], x) for x in xs])))
    print("max |js - sklearn| prob:", float(np.abs(js_p - clf.predict_proba(Xte.iloc[:300])[:, 1]).max()))
    print(json.dumps(out["metrics"], indent=1))
    print("size KB:", os.path.getsize(OUT) / 1024)


if __name__ == "__main__":
    main()
