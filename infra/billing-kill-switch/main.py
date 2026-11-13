"""Billing kill switch for the Shoestring production project (FALLBACK ONLY).

Use this only if a Cloud Billing spend cap is not available for Cloud Run
(see docs/runbooks/billing-protection.md, step 2B). It is DESTRUCTIVE: detaching
billing stops every billable service in the target project, and Google may
eventually delete resources in a project without billing. The database (Neon)
and backups (separate project) are outside its reach by design.

Triggered by Pub/Sub budget notifications. Detaches the billing account from
TARGET_PROJECT_ID when costAmount exceeds budgetAmount. Unless DRY_RUN is set
to the exact string "false" it only logs what it would do. Deploy with
DRY_RUN=true first and test it.
"""

import base64
import json
import os

import functions_framework
from googleapiclient import discovery

TARGET_PROJECT_ID = os.environ["TARGET_PROJECT_ID"]
DRY_RUN = os.environ.get("DRY_RUN", "true").lower() != "false"
PROJECT_NAME = f"projects/{TARGET_PROJECT_ID}"


def _log(severity: str, message: str, **fields) -> None:
    print(json.dumps({"severity": severity, "message": message, **fields}))


@functions_framework.cloud_event
def stop_billing(cloud_event) -> None:
    payload = json.loads(base64.b64decode(cloud_event.data["message"]["data"]).decode("utf-8"))
    cost = float(payload.get("costAmount", 0))
    budget = float(payload.get("budgetAmount", 0))

    if budget <= 0 or cost <= budget:
        _log("INFO", "under budget, no action", cost=cost, budget=budget)
        return

    billing = discovery.build("cloudbilling", "v1", cache_discovery=False)
    projects = billing.projects()
    info = projects.getBillingInfo(name=PROJECT_NAME).execute()
    if not info.get("billingEnabled"):
        _log("INFO", "billing already disabled", project=TARGET_PROJECT_ID)
        return

    if DRY_RUN:
        _log("WARNING", "DRY_RUN: would disable billing", project=TARGET_PROJECT_ID, cost=cost, budget=budget)
        return

    projects.updateBillingInfo(name=PROJECT_NAME, body={"billingAccountName": ""}).execute()
    _log("CRITICAL", "billing disabled", project=TARGET_PROJECT_ID, cost=cost, budget=budget)
