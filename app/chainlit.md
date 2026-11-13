# Bank assistant

A sample application built on Red Hat OpenShift AI platform APIs: every message goes through NeMo Guardrails
(masking, prompt-injection defence, output checks) to a model served through Models-as-a-Service, and each
call writes a masked audit record to MLflow.

Pick an application profile at the top to see how the same platform applies a different policy per application.
