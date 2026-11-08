use super::*;

pub(super) fn schemas() -> Value {
    json!({"ProductInsights": product_insights()})
}
